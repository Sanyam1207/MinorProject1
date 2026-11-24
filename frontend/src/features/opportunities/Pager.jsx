import { ChevronLeft, ChevronRight } from "lucide-react";

/** PREV / page / NEXT. Hidden when there is only one page. */
export default function Pager({ page = 1, hasNextPage = false, total, pageSize, onChange }) {
  if (page <= 1 && !hasNextPage) return null;
  const pages = Number.isFinite(total) && pageSize ? Math.max(1, Math.ceil(total / pageSize)) : null;
  return (
    <nav aria-label="Pagination" className="flex items-center justify-center gap-2 pt-1">
      <button
        type="button"
        onClick={() => onChange(page - 1)}
        disabled={page <= 1}
        className="btn-secondary min-h-11 px-3 py-1.5 text-xs disabled:opacity-40 sm:min-h-0"
      >
        <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
        PREV
      </button>
      <span className="badge-stark text-[10px] tabular-nums">
        PAGE {page}
        {pages ? ` / ${pages}` : ""}
      </span>
      <button
        type="button"
        onClick={() => onChange(page + 1)}
        disabled={!hasNextPage}
        className="btn-secondary min-h-11 px-3 py-1.5 text-xs disabled:opacity-40 sm:min-h-0"
      >
        NEXT
        <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </nav>
  );
}
