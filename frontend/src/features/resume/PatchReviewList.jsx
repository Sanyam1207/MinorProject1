import { Check, X } from "lucide-react";
import { diffWords } from "./patches.js";

const STATE_BADGES = {
  moved: { label: "MOVED", className: "bg-blue-100", hint: "The text moved; it will be re-located when applied." },
  stale: { label: "STALE", className: "bg-orange-100", hint: "This text is no longer in the resume — it will be skipped." },
  overlap: { label: "OVERLAPS", className: "bg-yellow-200", hint: "Overlaps another suggestion; only one of them can apply." },
};

function DiffText({ parts, tone }) {
  return (
    <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[11px] leading-5">
      {parts.map((part, index) =>
        part.changed ? (
          <mark key={index} className={tone === "remove" ? "bg-red-200 text-black line-through decoration-red-700" : "bg-green-200 text-black"}>
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </pre>
  );
}

function PatchCard({ patch, decision, state, onDecide, readOnly }) {
  const diff = diffWords(patch.originalSubstring, patch.replacementSubstring);
  const badge = STATE_BADGES[state];
  const accepted = decision === "accept";
  const lines = patch.lineRange
    ? patch.lineRange.startLine === patch.lineRange.endLine
      ? `Line ${patch.lineRange.startLine}`
      : `Lines ${patch.lineRange.startLine}–${patch.lineRange.endLine}`
    : null;

  return (
    <li className={`border-2 border-black p-3 ${accepted ? "bg-white" : "bg-gray-100 opacity-80"}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="badge-stark bg-purple-100 text-[9px] uppercase">{patch.section}</span>
            {lines && <span className="badge-stark font-mono text-[9px]">{lines}</span>}
            {badge && (
              <span className={`badge-stark text-[9px] ${badge.className}`} title={badge.hint}>
                {badge.label}
              </span>
            )}
            {patch.autoEscaped && <span className="badge-stark text-[9px]">AUTO-ESCAPED</span>}
          </div>
          <h4 className="mt-1.5 text-xs font-black uppercase">{patch.targetContext || patch.section}</h4>
        </div>
        {!readOnly && (
          <div className="flex shrink-0 border-[1.5px] border-black" role="group" aria-label={`Decision for ${patch.id}`}>
            <button
              type="button"
              aria-pressed={accepted}
              onClick={() => onDecide(patch.id, "accept")}
              className={`inline-flex min-h-9 items-center gap-1 px-2 py-1 text-[10px] font-black ${accepted ? "bg-black text-white" : "bg-white hover:bg-gray-100"}`}
            >
              <Check className="h-3.5 w-3.5" aria-hidden="true" /> ACCEPT
            </button>
            <button
              type="button"
              aria-pressed={!accepted}
              onClick={() => onDecide(patch.id, "reject")}
              className={`inline-flex min-h-9 items-center gap-1 border-l-[1.5px] border-black px-2 py-1 text-[10px] font-black ${!accepted ? "bg-red-200" : "bg-white hover:bg-gray-100"}`}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" /> REJECT
            </button>
          </div>
        )}
      </div>
      {patch.reasoning && <p className="mt-1.5 text-[11px] font-medium text-gray-700">{patch.reasoning}</p>}
      {patch.keywordsAdded.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {patch.keywordsAdded.map((keyword) => (
            <span key={keyword} className="badge-stark bg-green-100 text-[9px]">
              + {keyword}
            </span>
          ))}
        </div>
      )}
      <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
        <div className="min-w-0 overflow-x-auto border-[1.5px] border-black bg-red-50 p-2">
          <div className="mb-1 text-[9px] font-black uppercase text-gray-600">Original</div>
          <DiffText parts={diff.before} tone="remove" />
        </div>
        <div className="min-w-0 overflow-x-auto border-[1.5px] border-black bg-green-50 p-2">
          <div className="mb-1 text-[9px] font-black uppercase text-gray-600">Suggested</div>
          <DiffText parts={diff.after} tone="add" />
        </div>
      </div>
    </li>
  );
}

/**
 * Review list for tailoring patches: per-patch ACCEPT / REJECT with a word diff.
 * `decisions` = { [patchId]: "accept" | "reject" }; `states` from patchStates().
 */
export default function PatchReviewList({ patches = [], decisions = {}, states = {}, onDecide, onDecideAll, readOnly = false }) {
  const acceptedCount = patches.filter((patch) => decisions[patch.id] !== "reject").length;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] font-black uppercase tabular-nums">
          {readOnly ? `${patches.length} suggestion(s)` : `${acceptedCount} of ${patches.length} accepted`}
        </span>
        {!readOnly && onDecideAll && (
          <div className="flex gap-1.5">
            <button type="button" onClick={() => onDecideAll("accept")} className="btn-secondary px-2 py-1 text-[10px]">
              ACCEPT ALL
            </button>
            <button type="button" onClick={() => onDecideAll("reject")} className="btn-secondary px-2 py-1 text-[10px]">
              REJECT ALL
            </button>
          </div>
        )}
      </div>
      <ul className="space-y-2">
        {patches.map((patch) => (
          <PatchCard
            key={patch.id}
            patch={patch}
            decision={decisions[patch.id] === "reject" ? "reject" : "accept"}
            state={states[patch.id]}
            onDecide={onDecide}
            readOnly={readOnly}
          />
        ))}
      </ul>
    </div>
  );
}
