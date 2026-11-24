import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { MODE_DEFS, allowedModesFor } from "../workspace/modes.js";
import ModeIcon from "../workspace/ModeIcon.jsx";

/** Mode selector limited to the role's modes (FRONTEND.md §4.2). One mode → a static box. */
export default function ModeDropdown({ activeMode, setActiveMode, userRole = "student" }) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef(null);
  const modes = allowedModesFor(userRole).map((id) => MODE_DEFS[id]).filter(Boolean);
  const current = modes.find((mode) => mode.id === activeMode) ?? modes[0];
  const single = modes.length <= 1;

  useEffect(() => {
    if (!isOpen) return undefined;
    const onPointerDown = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) setIsOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown, { passive: true });
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isOpen]);

  const summary = (
    <span className="flex min-w-0 items-center gap-2.5">
      <span className="shrink-0 bg-black p-1 text-white">
        <ModeIcon name={current?.icon} className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 text-left">
        <span className="block text-[10px] font-extrabold uppercase leading-none tracking-wider text-gray-500">Current mode</span>
        <span className="mt-0.5 block truncate text-xs font-black uppercase text-black">{current?.label ?? "Workspace"}</span>
      </span>
    </span>
  );

  if (single) {
    return <div className="flex w-full items-center justify-between gap-2.5 border border-gray-900 bg-white px-3.5 py-1.5 sm:w-72">{summary}</div>;
  }

  return (
    <div className="relative w-full sm:w-72" ref={containerRef}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
        className="flex min-h-11 w-full items-center justify-between gap-2.5 border border-gray-900 bg-white px-3.5 py-1.5 transition-colors hover:bg-gray-50 sm:min-h-0"
      >
        {summary}
        <ChevronDown className={`h-4 w-4 shrink-0 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>

      {isOpen && (
        <ul role="listbox" aria-label="Workspace mode" className="absolute left-0 right-0 z-50 mt-1.5 divide-y divide-gray-100 border-2 border-black bg-white shadow-md">
          {modes.map((mode) => {
            const selected = mode.id === current?.id;
            return (
              <li key={mode.id} role="option" aria-selected={selected}>
                <button
                  type="button"
                  onClick={() => {
                    setIsOpen(false);
                    if (!selected) setActiveMode(mode.id);
                  }}
                  className={`flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors ${selected ? "bg-black text-white" : "text-black hover:bg-gray-100"}`}
                >
                  <span className={`mt-0.5 p-1.5 ${selected ? "bg-white text-black" : "bg-black text-white"}`}>
                    <ModeIcon name={mode.icon} className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-1">
                      <span className="truncate text-xs font-black uppercase tracking-tight">{mode.label}</span>
                      {selected && <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
                    </span>
                    <span className={`mt-0.5 line-clamp-1 block text-[11px] font-medium leading-tight ${selected ? "text-gray-300" : "text-gray-600"}`}>
                      {mode.description}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
