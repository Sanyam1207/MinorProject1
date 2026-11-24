import { useRef } from "react";

/**
 * Monospace source editor with a line-number gutter (keeps its own dark palette,
 * FRONTEND.md §15.3). Lines don't wrap so the gutter stays aligned.
 */
export default function LatexEditor({ value = "", onChange, readOnly = false, errorLine = null, label = "LaTeX source" }) {
  const gutterRef = useRef(null);
  const lineCount = Math.max(1, value.split("\n").length);
  const numbers = Array.from({ length: lineCount }, (_, index) => index + 1);

  return (
    <div className="flex min-h-[420px] min-w-0 flex-1 overflow-hidden bg-[#17191c] font-mono text-[12px] leading-5 text-gray-100 lg:min-h-0">
      <div
        ref={gutterRef}
        aria-hidden="true"
        className="select-none overflow-hidden border-r border-gray-700 bg-[#1f2226] py-3 pl-2 pr-2 text-right text-gray-500"
      >
        {numbers.map((number) => (
          <div key={number} className={number === errorLine ? "bg-red-700 text-white" : ""}>
            {number}
          </div>
        ))}
      </div>
      <textarea
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
        onScroll={(event) => {
          if (gutterRef.current) gutterRef.current.scrollTop = event.currentTarget.scrollTop;
        }}
        readOnly={readOnly}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        wrap="off"
        aria-label={label}
        className="min-h-0 min-w-0 flex-1 resize-none overflow-auto bg-transparent px-3 py-3 font-mono text-base leading-5 text-gray-100 caret-white outline-none sm:text-[12px]"
      />
    </div>
  );
}
