// Public workspace API for every frontend owner (FRONTEND.md §11.2).
// Only plain .js modules are re-exported here so `node --test` can import it.
export { openPanel, switchMode, applyUiActions, bindUiActions, createUiActionApplier } from "./uiActions.js";
export { usePanel, useActivePanel } from "./usePanel.js";
export {
  PANELS,
  PANELS_BY_ROLE,
  PANEL_ID_ALIASES,
  sanitizeParams,
  resolvePanel,
  resolveTarget,
  panelTitle,
  isFullHeightPanel,
} from "./panels.js";
export {
  MODE_DEFS,
  ROLE_MODES,
  allowedModesFor,
  defaultModeFor,
  isModeAllowed,
  needsModeChoice,
  homePanelFor,
  roleLabel,
} from "./modes.js";
export { buildPanelUrl, parsePanelUrl } from "./deepLink.js";
export { AGENT_MODE_BY_HEADER } from "./agentModes.js";
export { headerLabel } from "./headerLabels.js";
export { toolLabel } from "./toolLabels.js";
