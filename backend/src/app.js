import express from "express";
import { CORS_ORIGINS } from "./config/config.js";
import cors from "cors";
import cookieParser from "cookie-parser";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ limit: "1mb", extended: true }));
app.use(cookieParser());
// Express 5 leaves req.body undefined when a request has no body; handlers
// across the codebase destructure it, so default it to an empty object.
app.use((req, _res, next) => {
    if (req.body === undefined) req.body = {};
    next();
});
app.use(cors({
    // CORS env: comma-separated allow-list; "*"/unset reflects any origin (local dev only).
    origin: CORS_ORIGINS,
    credentials: true,
    methods: ["GET", "PATCH", "PUT", "POST", "DELETE", "OPTIONS"],
}));
// API responses are per-user; never let a proxy/CDN cache them.
app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
});
import health_router from "./routes/healthcheck.routes.js";
import auth_router from "./routes/auth.routes.js";
import ggsipu_router from "./routes/ggsipu.routes.js";
import pr_outreach_router from "./routes/pr-outreach.routes.js";
import alumni_router from "./routes/alumni.routes.js";
import resume_bank_router from "./routes/resume-bank.routes.js";
import interview_router from "./routes/interview.routes.js";
import { mountModuleRouters } from "./modules/index.js";

app.use("/api/v1/healthcheck", health_router);
app.use("/api/v1/auth", auth_router);
app.use("/api/v1/ggsipu", ggsipu_router);
app.use("/api/v1/pr-outreach", pr_outreach_router);
app.use("/api/v1/alumni", alumni_router);
app.use("/api/v1/resume-bank", resume_bank_router);
app.use("/api/v1/interviews", interview_router);

// Feature modules (attendance, notifications, placements, job feed, resume lab,
// BYOK LLM keys, faculty, issue reports, agent tools). /api/v1/jobs is owned by
// the placements module.
mountModuleRouters(app);

app.use("/api", (req, res) => {
    res.status(404).json({ success: false, message: `No route for ${req.method} ${req.originalUrl}`, errors: [{ code: "NOT_FOUND" }], data: null });
});

import { ApiError } from "./utils/api-error.js";

app.use((err, req, res, next) => {
    if (err instanceof ApiError) {
        return res.status(err.statusCode).json({
            success: err.success,
            message: err.message,
            errors: err.errors,
            data: err.data,
        });
    }

    // Translate common Mongoose / MongoDB failures into client errors.
    if (err?.name === "CastError") {
        return res.status(400).json({ success: false, message: `Invalid ${err.path || "value"}`, errors: [{ code: "VALIDATION", field: err.path }], data: null });
    }
    if (err?.name === "ValidationError") {
        const fields = Object.keys(err.errors || {});
        return res.status(400).json({ success: false, message: err.message, errors: [{ code: "VALIDATION", fields }], data: null });
    }
    if (err?.code === 11000) {
        return res.status(409).json({ success: false, message: "A record with these details already exists", errors: [{ code: "DUPLICATE", keys: Object.keys(err.keyValue || {}) }], data: null });
    }

    // Multer / body-parser errors carry a status; keep their message.
    const status = Number(err.status || err.statusCode) || 500;
    if (status >= 500) console.error(err);
    return res.status(status).json({
        success: false,
        message: status >= 500 && process.env.NODE_ENV === "production" ? "Internal server error" : (err.message || "Internal server error"),
        errors: [{ code: err.code || (status >= 500 ? "INTERNAL" : "ERROR") }],
        data: null,
    });
});

export { app };
