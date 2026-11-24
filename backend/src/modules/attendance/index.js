// Module "attendance": courses, scheduling (manual, automatic, timetable),
// live sessions with a rotating single-use QR, scanning, reports and the
// copilot tools (docs/contracts/ATTENDANCE.md). Mounted at /api/v1/attendance.
//
// Models (other modules may read them through mongoose.models):
//   Course (`courses`), ClassSession (`class_sessions`), AttendanceRecord (`attendance_records`).
// Socket: attendance:presenter:join / :leave (client → server); attendance:qr,
//   attendance:marked, attendance:session, attendance:confirmed (server → client).
// Jobs (core/scheduler.js): QR rotation 1 s, reminders 60 s, auto-end 60 s, timetable 6 h + boot.
import { registerAttendanceJobs } from "./jobs.js";
import "./models/index.js";
import router from "./routes.js";
import { registerAttendanceSocket } from "./socket.js";
import tools from "./tools.js";

export default {
    name: "attendance",
    mountPath: "/api/v1/attendance",
    router,
    registerSocket: (io, socket) => registerAttendanceSocket(io, socket),
    start: () => {
        registerAttendanceJobs();
    },
    tools,
};
