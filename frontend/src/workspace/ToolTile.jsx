import { ArrowRight } from "lucide-react";

/** Tool tile recipe (FRONTEND.md §15.4): one <button>, icon box, title, 2-line copy, badge + "OPEN →". */
export default function ToolTile({ icon: Icon, title, description, badge, badgeClass = "bg-gray-100", onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="card-stark group flex min-h-48 w-full cursor-pointer flex-col items-center justify-between bg-white p-4 text-center transition-all hover:-translate-y-0.5 hover:bg-gray-50"
    >
      <span className="mb-2 bg-black p-3.5 text-white">
        <Icon className="h-8 w-8" aria-hidden="true" />
      </span>
      <span className="my-auto space-y-1">
        <span className="block text-sm font-black uppercase tracking-tight group-hover:underline">{title}</span>
        <span className="line-clamp-2 block text-[11px] font-medium text-gray-600">{description}</span>
      </span>
      <span className="mt-auto flex w-full items-center justify-between gap-2 border-t-[1.5px] border-black pt-2">
        <span className={`badge-stark max-w-[65%] truncate text-[10px] ${badgeClass}`}>{badge}</span>
        <span className="btn-primary px-2 py-1 text-[10px]">
          OPEN <ArrowRight className="h-3 w-3" aria-hidden="true" />
        </span>
      </span>
    </button>
  );
}
