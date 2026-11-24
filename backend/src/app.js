import express from "express";
import { CORS } from "./config/config.js";
import cors from "cors";
import cookieParser from "cookie-parser";

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ limit: "256kb", extended: true }));
app.use(cookieParser());
app.use(cors({
    origin: (origin, callback) => callback(null, true), // Allow all origins for dev/testing
    credentials: true,
    methods: ["GET", "PATCH", "PUT", "POST", "DELETE", "OPTIONS"],
}));
import health_router from "./routes/healthcheck.routes.js";
import auth_router from "./routes/auth.routes.js";
import ggsipu_router from "./routes/ggsipu.routes.js";
import job_router from "./routes/job.routes.js";
import pr_outreach_router from "./routes/pr-outreach.routes.js";
import alumni_router from "./routes/alumni.routes.js";
import resume_bank_router from "./routes/resume-bank.routes.js";
import interview_router from "./routes/interview.routes.js";

app.use("/api/v1/healthcheck", health_router);
app.use("/api/v1/auth", auth_router);
app.use("/api/v1/ggsipu", ggsipu_router);
app.use("/api/v1/jobs", job_router);
app.use("/api/v1/pr-outreach", pr_outreach_router);
app.use("/api/v1/alumni", alumni_router);
app.use("/api/v1/resume-bank", resume_bank_router);
app.use("/api/v1/interviews", interview_router);

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

    console.error(err);
    return res.status(500).json({
        success: false,
        message: err.message || "Internal server error",
    });
});

export { app };
