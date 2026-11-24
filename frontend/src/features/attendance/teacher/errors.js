// Error text for teacher-facing actions. The server's messages are specific
// ("You can start this class from 9:30 am", "That time overlaps CS301 …"), so
// they win; the §14.4 table is the fallback.
import { attendanceErrorMessage } from "../../../lib/api/attendance.js";

export const teacherError = (error, fallback = "Something went wrong") => {
  const message = error?.message;
  if (message && message !== "Request failed") return message;
  return attendanceErrorMessage(error, fallback);
};

/** `details.conflicts` of a 409 SCHEDULE_CONFLICT, else []. */
export const conflictsOf = (error) =>
  error?.code === "SCHEDULE_CONFLICT" && Array.isArray(error?.details?.conflicts) ? error.details.conflicts : [];
