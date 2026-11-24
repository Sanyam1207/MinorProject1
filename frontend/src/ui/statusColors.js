// Status → accent class (FRONTEND.md §15.5). Use these, never ad-hoc colors.
export const STATUS_COLORS = Object.freeze({
  attendance: { present: "bg-green-200", late: "bg-yellow-200", absent: "bg-red-200", excused: "bg-blue-100" },
  standing: { safe: "bg-green-200", warning: "bg-yellow-200", critical: "bg-red-200", "no-data": "bg-gray-100" },
  session: { scheduled: "bg-blue-100", live: "bg-black text-white", ended: "bg-gray-200", cancelled: "bg-red-100 line-through", missed: "bg-orange-100" },
  application: { applied: "bg-blue-100", shortlisted: "bg-purple-100", test: "bg-yellow-100", interview: "bg-yellow-200", offered: "bg-green-200", selected: "bg-green-200", rejected: "bg-red-100", withdrawn: "bg-gray-200" },
  offer: { extended: "bg-blue-100", accepted: "bg-green-200", rejected: "bg-red-100", withdrawn: "bg-gray-200", expired: "bg-orange-100", placed: "bg-black text-white" },
  tracker: { saved: "bg-yellow-100", applied: "bg-blue-100", interviewing: "bg-purple-100", offer: "bg-green-200", rejected: "bg-red-100" },
  priority: { low: "bg-gray-100", normal: "bg-blue-100", high: "bg-red-200" },
});

export const statusColor = (kind, status) => STATUS_COLORS[kind]?.[status] ?? "bg-gray-100";
