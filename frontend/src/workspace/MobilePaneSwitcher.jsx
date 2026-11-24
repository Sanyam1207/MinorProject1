import { useDispatch, useSelector } from "react-redux";
import { LayoutPanelLeft, MessageSquare } from "lucide-react";
import { mobilePaneChanged } from "../store/appContextSlice.js";

/** Phone/tablet (< lg) bottom bar: CHAT | WORKSPACE, with a dot when the copilot changed the workspace. */
export default function MobilePaneSwitcher() {
  const dispatch = useDispatch();
  const pane = useSelector((state) => state.appContext.mobilePane);
  const attention = useSelector((state) => state.appContext.workspaceAttention);

  const tabClass = (active) =>
    `relative flex min-h-12 flex-1 items-center justify-center gap-2 text-xs font-black uppercase transition-colors ${active ? "bg-black text-white" : "bg-white text-black hover:bg-gray-100"}`;

  return (
    <nav
      aria-label="Switch between chat and workspace"
      className="flex shrink-0 border-t-2 border-black bg-white pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      <button type="button" aria-pressed={pane === "chat"} onClick={() => dispatch(mobilePaneChanged("chat"))} className={tabClass(pane === "chat")}>
        <MessageSquare className="h-4 w-4" aria-hidden="true" /> Chat
      </button>
      <button
        type="button"
        aria-pressed={pane === "workspace"}
        onClick={() => dispatch(mobilePaneChanged("workspace"))}
        className={`${tabClass(pane === "workspace")} border-l-2 border-black`}
      >
        <LayoutPanelLeft className="h-4 w-4" aria-hidden="true" /> Workspace
        {attention && pane !== "workspace" && (
          <span className="absolute right-3 top-2 h-2.5 w-2.5 border border-black bg-yellow-300" aria-label="Workspace updated" />
        )}
      </button>
    </nav>
  );
}
