// Tool name → short chip label (FRONTEND.md §8.4). Covers every tool in
// AGENT-TOOLS.md §5 plus the area extensions (AUTH-FACULTY recruiter and
// issue-report tools). Unknown tools fall back to "UNDERSCORES → SPACES".

export const TOOL_LABELS = Object.freeze({
  // common
  open_panel: "Open panel",
  get_my_profile: "My profile",
  notifications_list: "Notifications",
  notifications_mark_read: "Mark notifications read",
  // attendance
  attendance_list_courses: "List courses",
  attendance_create_course: "Create course",
  attendance_list_sessions: "List classes",
  attendance_schedule_class: "Schedule class",
  attendance_auto_schedule_class: "Find a free slot",
  attendance_reschedule_class: "Reschedule class",
  attendance_cancel_class: "Cancel class",
  attendance_start_session: "Start attendance",
  attendance_end_session: "End attendance",
  attendance_session_report: "Session report",
  attendance_course_report: "Course report",
  attendance_notify_defaulters: "Notify defaulters",
  attendance_mark_manual: "Mark attendance",
  attendance_my_summary: "My attendance",
  attendance_my_schedule: "My schedule",
  attendance_join_course: "Join course",
  attendance_open_scanner: "Open QR scanner",
  // placements
  jobs_search_campus: "Search campus drives",
  job_details: "Job details",
  drive_apply: "Apply to drive",
  applications_list: "My applications",
  application_withdraw: "Withdraw application",
  offers_list: "Offers",
  offer_respond: "Respond to offer",
  training_list: "Training programs",
  training_register: "Register for training",
  drives_list: "Placement drives",
  drive_create: "Create drive",
  drive_close: "Close drive",
  applicants_list: "Applicants",
  application_update_status: "Update application",
  offer_create: "Create offer",
  placement_stats: "Placement stats",
  announce: "Announcement",
  // job feed
  jobs_search_market: "Search job feed",
  market_job_save: "Save job",
  market_job_mark_applied: "Mark job applied",
  job_feed_sync: "Sync job feed",
  // resume lab / byok
  resume_list: "My resumes",
  resume_score: "Score resume",
  resume_tailor_for_job: "Tailor resume",
  // faculty / recruiters / issues
  faculty_list: "Faculty",
  faculty_invite: "Invite faculty",
  recruiters_list: "Recruiters",
  recruiter_invite: "Invite recruiter",
  issue_report_create: "Report issue",
});

export function toolLabel(name) {
  if (typeof name !== "string" || !name) return "TOOL";
  if (Object.hasOwn(TOOL_LABELS, name)) return TOOL_LABELS[name].toUpperCase();
  return name.replace(/_+/g, " ").trim().toUpperCase();
}
