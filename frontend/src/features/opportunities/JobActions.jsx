import { useState } from "react";
import { useDispatch } from "react-redux";
import { Bookmark, BookmarkCheck, CheckCheck, ExternalLink, Eye, FileText, LoaderCircle, Mic2, Send } from "lucide-react";
import { saveMarketJob } from "../../lib/api/jobFeed.js";
import { runAIFeature } from "../../services/aiRequestHandler.js";
import { journeyJobSelected } from "../../store/aiChatSlice.js";
import { Modal, StatusBadge, toastError, toastSuccess } from "../../ui/index.js";
import { openPanel } from "../../workspace/index.js";
import ApplyDialog from "./ApplyDialog.jsx";
import { toAgentJob } from "./jobVM.js";
import { APPLICATION_LABELS, TRACKER_LABELS, applicationColorKey, openExternal, safeUrl } from "./labels.js";

const APPLIED_LIKE = new Set(["applied", "interviewing", "offer", "rejected"]);
const btn = "min-h-11 px-2.5 py-1.5 text-[11px] disabled:opacity-50 sm:min-h-0";

/**
 * The action row for a JobVM (cards and the detail view).
 * Props: { job, from: "matched"|"campus"|"market"|"tracker", variant: "card"|"detail", onChange?(patch) }
 * Campus: in-portal APPLY (ApplyDialog) or APPLY NOW link, disabled with reason when blocked.
 * External: APPLY opens the link and offers MARK AS APPLIED; SAVE / MARK APPLIED update the tracker.
 */
export default function JobActions({ job, from, variant = "card", onChange }) {
  const dispatch = useDispatch();
  const [applyOpen, setApplyOpen] = useState(false);
  const [markPrompt, setMarkPrompt] = useState(false);
  const [busy, setBusy] = useState(null);
  const url = safeUrl(job.applicationUrl);

  const track = async (status) => {
    if (busy) return;
    setBusy(status);
    try {
      const item = await saveMarketJob(job.id, { status });
      onChange?.({ saved: item?.status ?? status, applicationStatus: item?.status ?? status });
      toastSuccess(status === "saved" ? "Saved to your tracker" : `Marked as ${TRACKER_LABELS[status]?.toLowerCase() ?? status}`);
    } catch (error) {
      toastError(error, "Could not update your tracker");
    } finally {
      setBusy(null);
      setMarkPrompt(false);
    }
  };

  const applyExternal = () => {
    if (!openExternal(url)) return;
    if (job.saveable && !APPLIED_LIKE.has(job.saved)) setMarkPrompt(true);
  };

  const practice = () => {
    dispatch(journeyJobSelected(toAgentJob(job)));
    openPanel("interview");
    dispatch(runAIFeature("mock-interview"));
  };

  const buttons = [];

  if (job.kind === "campus") {
    const status = job.applicationStatus;
    if (status && status !== "withdrawn") {
      buttons.push(
        <StatusBadge key="status" kind="application" status={applicationColorKey(status)}>
          {(APPLICATION_LABELS[status] ?? status).toUpperCase()}
        </StatusBadge>,
      );
      if (job.myApplication?._id) {
        buttons.push(
          <button key="view-app" type="button" onClick={() => openPanel("applications", { applicationId: job.myApplication._id })} className={`btn-secondary ${btn}`}>
            VIEW APPLICATION
          </button>,
        );
      }
    } else if (url) {
      buttons.push(
        <a key="apply-link" href={url} target="_blank" rel="noopener noreferrer" className={`btn-primary ${btn}`}>
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          APPLY NOW
        </a>,
      );
    } else if (job.canApply === false) {
      buttons.push(
        <button key="apply-blocked" type="button" disabled title={job.applyBlockedReason || undefined} className={`btn-primary ${btn} cursor-not-allowed`}>
          <Send className="h-3.5 w-3.5" aria-hidden="true" />
          {job.applyBlockedReason && /deadline/i.test(job.applyBlockedReason) ? "CLOSED" : "CAN'T APPLY"}
        </button>,
      );
    } else if (job.hasDetail) {
      buttons.push(
        <button key="apply" type="button" onClick={() => setApplyOpen(true)} className={`btn-primary ${btn}`}>
          <Send className="h-3.5 w-3.5" aria-hidden="true" />
          APPLY
        </button>,
      );
    }
  } else {
    if (url) {
      buttons.push(
        <button key="apply-ext" type="button" onClick={applyExternal} className={`btn-primary ${btn}`}>
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          APPLY
        </button>,
      );
    }
    if (job.saveable) {
      if (!job.saved) {
        buttons.push(
          <button key="save" type="button" onClick={() => track("saved")} disabled={Boolean(busy)} className={`btn-secondary ${btn}`}>
            {busy === "saved" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Bookmark className="h-3.5 w-3.5" aria-hidden="true" />}
            SAVE
          </button>,
        );
      } else {
        buttons.push(
          <button
            key="saved"
            type="button"
            onClick={() => openPanel("jobs.tracker", { status: job.saved, highlightId: job.id })}
            className={`badge-stark text-[10px] ${job.saved === "saved" ? "bg-yellow-100" : "bg-blue-100"} min-h-11 sm:min-h-0`}
            title="Open in your tracker"
          >
            <BookmarkCheck className="h-3 w-3" aria-hidden="true" />
            {(TRACKER_LABELS[job.saved] ?? job.saved).toUpperCase()}
          </button>,
        );
      }
      if (!APPLIED_LIKE.has(job.saved)) {
        buttons.push(
          <button key="mark" type="button" onClick={() => track("applied")} disabled={Boolean(busy)} className={`btn-secondary ${btn}`}>
            {busy === "applied" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />}
            MARK APPLIED
          </button>,
        );
      }
    }
  }

  if (variant === "card" && job.hasDetail) {
    buttons.push(
      <button key="details" type="button" onClick={() => openPanel("jobs.detail", { jobId: job.id, source: job.source, from })} className={`btn-secondary ${btn}`}>
        <Eye className="h-3.5 w-3.5" aria-hidden="true" />
        DETAILS
      </button>,
    );
  }
  if (job.hasDetail) {
    buttons.push(
      <button
        key="tailor"
        type="button"
        onClick={() => openPanel("resume.lab", { tab: "tailor", jobId: job.id, jobSource: job.source })}
        className={`btn-secondary ${btn}`}
      >
        <FileText className="h-3.5 w-3.5" aria-hidden="true" />
        TAILOR RESUME
      </button>,
    );
  }
  if (variant === "detail") {
    buttons.push(
      <button key="practice" type="button" onClick={practice} className={`btn-secondary ${btn}`}>
        <Mic2 className="h-3.5 w-3.5" aria-hidden="true" />
        PRACTICE INTERVIEW
      </button>,
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">{buttons}</div>
      <ApplyDialog
        open={applyOpen}
        job={job}
        onClose={() => setApplyOpen(false)}
        onApplied={(application) =>
          onChange?.({
            applicationStatus: application?.status ?? "applied",
            canApply: false,
            myApplication: application ? { _id: application._id, status: application.status } : job.myApplication,
          })
        }
      />
      <Modal
        open={markPrompt}
        size="sm"
        title="DID YOU APPLY?"
        onClose={busy ? undefined : () => setMarkPrompt(false)}
        footer={
          <>
            <button type="button" onClick={() => setMarkPrompt(false)} disabled={Boolean(busy)} className="btn-secondary min-h-11 px-3 py-1.5 text-xs sm:min-h-0">
              NOT YET
            </button>
            <button type="button" onClick={() => track("applied")} disabled={Boolean(busy)} className="btn-primary min-h-11 px-3 py-1.5 text-xs sm:min-h-0">
              {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />}
              MARK AS APPLIED
            </button>
          </>
        }
      >
        <p className="text-xs font-medium text-gray-800">
          The application page for <strong>{job.roleTitle}</strong> at <strong>{job.companyName}</strong> opened in a new tab. Mark it as
          applied to track it under SAVED &amp; APPLIED.
        </p>
      </Modal>
    </>
  );
}
