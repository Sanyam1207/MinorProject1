import { ArrowRight } from "lucide-react";
import { resolvePanel } from "./panels.js";
import { openPanel } from "./uiActions.js";

/**
 * "→ OPENED …" chips for the panels a copilot answer opened (FRONTEND.md §8.4).
 * Titles follow the role's alias resolution; panels the role cannot open are not shown.
 */
export default function OpenedPanelChips({ uiActions, role }) {
  if (!Array.isArray(uiActions) || uiActions.length === 0) return null;
  const seen = new Set();
  const chips = [];
  for (const action of uiActions) {
    const resolution = resolvePanel(action?.panel, role);
    if (!resolution.ok || seen.has(resolution.panelId)) continue;
    seen.add(resolution.panelId);
    chips.push({ key: resolution.panelId, title: resolution.panel.title, panel: action.panel, params: action.params ?? {} });
  }
  if (chips.length === 0) return null;
  return (
    <div className="mt-1.5 flex max-w-[85%] flex-wrap gap-1.5">
      {chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          onClick={() => openPanel(chip.panel, chip.params)}
          className="inline-flex min-h-9 items-center gap-1 border border-black bg-purple-100 px-2 py-1 text-[10px] font-black uppercase hover:bg-purple-200 sm:min-h-0"
        >
          <ArrowRight className="h-3 w-3" aria-hidden="true" />
          OPENED {chip.title}
        </button>
      ))}
    </div>
  );
}
