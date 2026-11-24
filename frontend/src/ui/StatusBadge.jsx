import { statusColor } from "./statusColors.js";

const humanize = (value) => String(value ?? "").replace(/[-_]+/g, " ").trim().toUpperCase();

export default function StatusBadge({ status, kind, children, className = "" }) {
  return (
    <span className={`badge-stark text-[10px] ${statusColor(kind, status)} ${className}`}>
      {children ?? (humanize(status) || "UNKNOWN")}
    </span>
  );
}
