import { useSelector } from "react-redux";
import Modal from "../../ui/Modal.jsx";
import { buildPanelUrl } from "../../workspace/deepLink.js";
import { usePanel } from "../../workspace/usePanel.js";
import ReportIssueForm from "./ReportIssueForm.jsx";

/** Overlay `report-issue` (UI-ACTIONS.md §3.7), prefilled from the user and `params.description`. */
export default function ReportIssueModal({ onClose }) {
  const user = useSelector((state) => state.appContext.user);
  const activePanel = useSelector((state) => state.appContext.activePanel);
  const activeParams = useSelector((state) => state.appContext.panelParams[state.appContext.activePanel]);
  const { params } = usePanel("report-issue");
  // The SPA URL is always "/", so the page context is the deep link of the panel on screen.
  const pageUrl = buildPanelUrl({ panel: activePanel, params: activeParams });

  return (
    <Modal open title="REPORT AN ISSUE" onClose={onClose} size="md">
      <ReportIssueForm
        defaultName={user?.name || ""}
        defaultEmail={user?.email || ""}
        defaultDescription={params.description || ""}
        pageUrl={pageUrl}
        signedIn={Boolean(user)}
        onDone={onClose}
      />
    </Modal>
  );
}
