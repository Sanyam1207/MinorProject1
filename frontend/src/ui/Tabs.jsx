export default function Tabs({ tabs = [], value, onChange, className = "", label = "Tabs" }) {
  return (
    <div role="tablist" aria-label={label} className={`scrollbar-hide flex w-full max-w-full items-center gap-1 overflow-x-auto ${className}`}>
      {tabs.map((tab) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange?.(tab.id)}
            className={`shrink-0 whitespace-nowrap px-3 py-1.5 text-xs font-black uppercase transition-colors ${selected ? "bg-black text-white" : "bg-gray-100 text-black hover:bg-gray-200"}`}
          >
            {tab.label}
            {Number.isFinite(tab.count) && (
              <span className={`ml-1.5 inline-block min-w-5 border px-1 text-[10px] tabular-nums ${selected ? "border-white" : "border-black bg-white"}`}>
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
