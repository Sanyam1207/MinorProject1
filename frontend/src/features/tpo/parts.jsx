// Small presentational building blocks shared by the TPO / recruiter panels (stark design, FRONTEND.md §15).
import { useState } from "react";
import { Search, X } from "lucide-react";

export function DataTable({ head, children, className = "" }) {
  return (
    <div className={`max-w-full overflow-x-auto ${className}`}>
      <table className="w-full border-collapse border-2 border-black text-left text-xs">
        <thead>
          <tr className="bg-black text-[10px] uppercase text-white">
            {head.map((label, index) => (
              <th key={`${label}-${index}`} scope="col" className="whitespace-nowrap border-2 border-black p-2 font-black">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Td({ children, className = "", ...rest }) {
  return (
    <td className={`border-2 border-black p-2 align-top ${className}`} {...rest}>
      {children}
    </td>
  );
}

/** Search box that submits on Enter / button (no request per keystroke). */
export function SearchBox({ value, onSearch, placeholder = "Search…", className = "" }) {
  const [text, setText] = useState(value ?? "");
  const [synced, setSynced] = useState(value ?? "");
  if ((value ?? "") !== synced) {
    setSynced(value ?? "");
    setText(value ?? "");
  }
  return (
    <form
      role="search"
      className={`flex min-w-0 items-stretch ${className}`}
      onSubmit={(event) => {
        event.preventDefault();
        onSearch(text.trim());
      }}
    >
      <input
        type="search"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="input-stark min-w-0 flex-1 text-base sm:text-xs"
      />
      {text && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            setText("");
            onSearch("");
          }}
          className="btn-secondary border-l-0 px-2"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
      <button type="submit" aria-label="Search" className="btn-primary px-3">
        <Search className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </form>
  );
}

export function SelectBox({ value, onChange, options, label, className = "" }) {
  return (
    <select
      value={value ?? ""}
      aria-label={label}
      onChange={(event) => onChange(event.target.value)}
      className={`input-stark text-base font-bold sm:text-xs ${className}`}
    >
      {options.map((option) => {
        const item = typeof option === "string" ? { value: option, label: option } : option;
        return (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        );
      })}
    </select>
  );
}

export function ColorBadge({ color = "bg-gray-100", children, className = "" }) {
  return <span className={`badge-stark whitespace-nowrap text-[10px] uppercase ${color} ${className}`}>{children}</span>;
}

export function KpiTile({ label, value, hint, accent = "bg-white" }) {
  return (
    <div className={`border-2 border-black p-3 ${accent}`}>
      <div className="text-[10px] font-black uppercase text-gray-600">{label}</div>
      <div className="mt-1 text-2xl font-black tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-[10px] font-semibold text-gray-600">{hint}</div>}
    </div>
  );
}

/** Horizontal CSS bar: label, bar scaled to `max`, value. */
export function BarRow({ label, value, max, display, color = "bg-black" }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (Number(value) || 0) / max * 100)) : 0;
  return (
    <div className="grid grid-cols-[minmax(0,7rem)_1fr_auto] items-center gap-2 text-[11px] font-bold sm:grid-cols-[minmax(0,10rem)_1fr_auto]">
      <span className="truncate uppercase" title={label}>{label}</span>
      <span className="h-3 border border-black bg-gray-100">
        <span className={`block h-full ${color}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="min-w-10 text-right tabular-nums">{display ?? value}</span>
    </div>
  );
}

export function Notice({ tone = "info", children }) {
  const tones = { info: "bg-blue-50", warn: "bg-yellow-100", error: "bg-red-50", success: "bg-green-100" };
  return <div className={`border-2 border-black p-3 text-xs font-bold ${tones[tone] ?? tones.info}`}>{children}</div>;
}

export function KeyValue({ label, children }) {
  return (
    <div className="min-w-0">
      <div className="text-[9px] font-black uppercase text-gray-500">{label}</div>
      <div className="break-words text-xs font-semibold">{children}</div>
    </div>
  );
}
