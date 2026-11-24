import http from "http"
import mongoose from "mongoose"
import { app } from "./app.js"
import { PORT, AGENT_TOOL_SECRET } from "./config/config.js"
import DBConnect from "./db/db.js"
import { attachSocketServer } from "./websocket/socket-server.js"
import { startModules } from "./modules/index.js"
import { startScheduler, stopScheduler } from "./core/scheduler.js"
import { flushDeliveries } from "./modules/notifications/notify.js"

const port = PORT || 8000
const server = http.createServer(app)
const io = attachSocketServer(server)

if (!process.env.ACCESS_TOKEN_SECRET || !process.env.REFRESH_TOKEN_SECRET) {
    console.error("ACCESS_TOKEN_SECRET and REFRESH_TOKEN_SECRET must be set (see backend/.env.example).")
    process.exit(1)
}
if (!AGENT_TOOL_SECRET) {
    console.warn("AGENT_TOOL_SECRET is not set: the AI copilot cannot call backend tools until it is configured.")
}

server.on("error", (error) => {
    console.error("Server failed to start:", error?.message)
    process.exit(1)
})

const shutdown = (signal) => {
    console.log(`${signal} received, shutting down...`)
    stopScheduler()
    io.close()
    server.close(() => {
        // Let in-flight push/email deliveries finish before the DB goes away.
        Promise.resolve(flushDeliveries()).catch(() => {})
            .finally(() => mongoose.connection.close(false).finally(() => process.exit(0)))
    })
    setTimeout(() => process.exit(0), 5000).unref()
}
process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))

DBConnect()
    .then(async () => {
        // Modules register their background jobs and boot-time work here.
        await startModules({ io })
        startScheduler()
        server.listen(port, () => {
            console.log(`Server is running on the port ${port}`)
        })
    })
    .catch((error) => {
        console.error("Not able to connect to DB:", error?.message || error)
        process.exit(1)
    })
