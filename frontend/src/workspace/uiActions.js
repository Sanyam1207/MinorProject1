// applyUiActions — the ONE way to change the right-hand workspace
// (UI-ACTIONS.md §6). Copilot tool results, legacy headers, notification
// clicks, deep links and the user's own clicks all become UI actions here.
//
// Pure core: createUiActionApplier({ getState, dispatch }) (node-tested).
// Bound instance: bindUiActions(store) once in main.jsx, then openPanel(),
// applyUiActions() and switchMode() work from anywhere.
import { IS_DEV } from "../lib/config.js";
import { setItem } from "../lib/storage.js";
import { panelOpened, setAgentMode } from "../store/appContextSlice.js";
import { modeChosen } from "../features/auth/sessionSlice.js";
import { agentModeForMode, homePanelFor, isModeAllowed } from "./modes.js";
import { resolvePanel, resolveTarget, sanitizeParams } from "./panels.js";

const DEDUPE_SOURCES = new Set(["copilot", "header"]);
const APPLIED_KEYS_CAP = 500;

const uid = () => globalThis.crypto?.randomUUID?.() ?? `ui-${Date.now()}-${Math.random().toString(16).slice(2)}`;

export function createUiActionApplier({ getState, dispatch }) {
  const appliedKeys = new Set();
  const remember = (key) => {
    appliedKeys.add(key);
    if (appliedKeys.size > APPLIED_KEYS_CAP) appliedKeys.delete(appliedKeys.values().next().value);
  };

  /**
   * applyUiActions(actions, { source = "user", requestId = null, role })
   *   → { applied: [{ id, panel }], skipped: [{ id, panel, reason }] }
   */
  return function applyUiActions(actions, { source = "user", requestId = null, role } = {}) {
    const list = Array.isArray(actions) ? actions : actions ? [actions] : [];
    const applied = [];
    const skipped = [];
    const batchKeys = new Set();

    list.forEach((action, index) => {
      if (!action || typeof action !== "object" || typeof action.panel !== "string" || !action.panel) {
        skipped.push({ id: action?.id ?? null, panel: action?.panel ?? null, reason: "INVALID" });
        return;
      }
      let id;
      if (source === "copilot") id = `${requestId}:${action.id ?? index}`;
      else if (source === "header") id = action.id ?? `hdr:${requestId}:${action.panel}:${action.params?.tab ?? ""}`;
      else id = uid();

      if (DEDUPE_SOURCES.has(source)) {
        if (appliedKeys.has(id) || batchKeys.has(id)) {
          skipped.push({ id, panel: action.panel, reason: "DUPLICATE" });
          return;
        }
        batchKeys.add(id);
      }

      const state = getState();
      const effectiveRole = role ?? state.appContext.userRole;
      const resolution = resolvePanel(action.panel, effectiveRole);
      if (!resolution.ok) {
        skipped.push({ id, panel: action.panel, reason: resolution.reason });
        return;
      }
      const { panelId } = resolution;

      let params;
      const storedParams = state.appContext.panelParams[panelId];
      if (action.params === undefined && source === "user" && storedParams) {
        params = storedParams;
      } else {
        const sanitized = sanitizeParams(panelId, action.params ?? {});
        if (sanitized.missing.length > 0) {
          skipped.push({ id, panel: action.panel, reason: "MISSING_PARAM" });
          return;
        }
        params = sanitized.params;
      }

      const target = resolveTarget(panelId, effectiveRole, params);
      // Never force a workspace mode the role cannot use (single table: modes.js).
      if (!target || (target.kind === "workspace" && !isModeAllowed(effectiveRole, target.mode))) {
        skipped.push({ id, panel: action.panel, reason: "FORBIDDEN" });
        return;
      }

      if (DEDUPE_SOURCES.has(source)) remember(id);
      const previousMode = state.appContext.activeMode;
      dispatch(panelOpened({ panelId, target, params, data: action.data, actionId: id, source, at: new Date().toISOString() }));
      applied.push({ id, panel: panelId });

      if (target.kind === "workspace") {
        if (!getState().session?.isModeChosen) {
          dispatch(modeChosen());
          setItem("isModeChosen", "true");
        }
        if (target.mode !== previousMode) setItem("activeMode", target.mode);
      }
    });

    if (IS_DEV && skipped.length > 0) {
      for (const entry of skipped) console.warn(`[ui-actions] skipped ${entry.panel ?? "?"} (${entry.reason})`, { source, requestId });
    }
    return { applied, skipped };
  };
}

// ─── Bound instance ──────────────────────────────────────────────────────────

let boundStore = null;
let boundApply = null;

export function bindUiActions(store) {
  boundStore = store;
  boundApply = createUiActionApplier({ getState: store.getState, dispatch: store.dispatch });
  return boundApply;
}

export function applyUiActions(actions, options) {
  if (!boundApply) {
    const list = Array.isArray(actions) ? actions : actions ? [actions] : [];
    return { applied: [], skipped: list.map((action) => ({ id: action?.id ?? null, panel: action?.panel ?? null, reason: "NOT_BOUND" })) };
  }
  return boundApply(actions, options);
}

/** User navigation. `params === undefined` keeps the panel's current params. */
export function openPanel(panelId, params, { data } = {}) {
  return applyUiActions([{ id: uid(), panel: panelId, params, data }], { source: "user" });
}

/** Mode dropdown / welcome cards / back to home: open the mode's home panel and set the sticky agent. */
export function switchMode(mode) {
  const result = openPanel(homePanelFor(mode));
  if (boundStore && result.applied.length > 0) boundStore.dispatch(setAgentMode(agentModeForMode(mode)));
  return result;
}
