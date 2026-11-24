// Save a Blob as a file (CSV export).
import { downloadSessionCsv } from "../../../lib/api/attendance.js";
import { istDayKey } from "./ist.js";

export const saveBlob = (blob, filename) => {
  if (typeof document === "undefined") return;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export const csvFilename = (course, session) => {
  const code = String(course?.code || session?.course?.code || "class").replace(/[^A-Za-z0-9_-]+/g, "-");
  return `attendance-${code}-${istDayKey(session?.startsAt) || "session"}.csv`;
};

/** GET /sessions/:id/export.csv → file download. */
export const exportSessionCsv = async (session, course) => {
  const blob = await downloadSessionCsv(session._id);
  const file = blob instanceof Blob ? blob : new Blob([blob], { type: "text/csv;charset=utf-8" });
  saveBlob(file, csvFilename(course, session));
};
