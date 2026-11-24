import mongoose from "mongoose";
import { Apiresponse } from "../utils/api-response.js";
import asynchandler from "../utils/asynchandler.js";

const healthcheck = asynchandler(async (_req, res) => {
    const database = mongoose.connection.readyState === 1 ? "up" : "down";
    return res.status(database === "up" ? 200 : 503)
        .json(new Apiresponse(database === "up" ? 200 : 503, { status: "ok", database, uptimeSeconds: Math.round(process.uptime()) }, "Server is running fine"));
});

export { healthcheck };
