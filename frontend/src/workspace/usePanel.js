// Panel params hooks (UI-ACTIONS.md §7). Components read their params ONLY
// through usePanel(panelId) and never touch state.appContext.panelParams.
import { useCallback } from "react";
import { useDispatch, useSelector, useStore } from "react-redux";
import { panelDataCleared, panelParamsUpdated } from "../store/appContextSlice.js";
import { canonicalPanelId, sanitizeParams } from "./panels.js";

const EMPTY_PARAMS = Object.freeze({});

/**
 * usePanel(panelId) → { params, data, nonce, active, setParams(patch, { replace = false }), clearData() }
 * `params` is a stable frozen `{}` when unset; `setParams` sanitises, merges by
 * default and does not bump `nonce` (so keyed children keep their state).
 */
export function usePanel(panelId) {
  const id = canonicalPanelId(panelId);
  const dispatch = useDispatch();
  const store = useStore();
  const params = useSelector((state) => state.appContext.panelParams[id]) ?? EMPTY_PARAMS;
  const data = useSelector((state) => state.appContext.panelData[id]);
  const nonce = useSelector((state) => state.appContext.panelNonce[id] ?? 0);
  const active = useSelector((state) => state.appContext.activePanel === id || state.appContext.overlay === id);

  const setParams = useCallback(
    (patch, { replace = false } = {}) => {
      const current = store.getState().appContext.panelParams[id] ?? EMPTY_PARAMS;
      const merged = replace ? { ...(patch || {}) } : { ...current, ...(patch || {}) };
      dispatch(panelParamsUpdated({ panelId: id, params: sanitizeParams(id, merged).params, replace: true }));
    },
    [dispatch, id, store],
  );
  const clearData = useCallback(() => dispatch(panelDataCleared(id)), [dispatch, id]);

  return { params, data, nonce, active, setParams, clearData };
}

/** The workspace panel on screen and its params, plus the open overlay. */
export function useActivePanel() {
  const panelId = useSelector((state) => state.appContext.activePanel);
  const params = useSelector((state) => state.appContext.panelParams[state.appContext.activePanel]) ?? EMPTY_PARAMS;
  const overlay = useSelector((state) => state.appContext.overlay);
  const nonce = useSelector((state) => state.appContext.panelNonce[state.appContext.activePanel] ?? 0);
  return { panelId, params, overlay, nonce };
}
