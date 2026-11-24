import { ArrowLeft } from "lucide-react";

/** Back bar recipe (FRONTEND.md §15.4): "← BACK TO … HOME" + black title badge. */
export default function BackBar({ label, title, onBack }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-[1.5px] border-black bg-white p-2.5 shadow-bold-sm">
      <button type="button" onClick={onBack} className="btn-secondary min-h-11 px-3 py-1.5 text-xs sm:min-h-0">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        <span>{label}</span>
      </button>
      {title && <span className="badge-stark max-w-full truncate bg-black text-xs font-extrabold uppercase text-white">{title}</span>}
    </div>
  );
}
