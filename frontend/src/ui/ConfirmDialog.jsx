import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import Modal from "./Modal.jsx";

function ConfirmBody({ title, body, confirmLabel, cancelLabel, danger, busy, requireReason, reasonLabel, onConfirm, onCancel }) {
  const [reason, setReason] = useState("");
  const blocked = busy || (requireReason && !reason.trim());
  return (
    <Modal
      open
      size="sm"
      title={title}
      onClose={busy ? undefined : onCancel}
      footer={
        <>
          <button type="button" onClick={onCancel} disabled={busy} className="btn-secondary min-h-11 px-3 py-1.5 text-xs disabled:opacity-50 sm:min-h-0">
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={() => onConfirm?.(reason.trim())}
            disabled={blocked}
            className={`btn-primary min-h-11 px-3 py-1.5 text-xs disabled:opacity-50 sm:min-h-0 ${danger ? "border-red-700 bg-red-600 hover:bg-red-700" : ""}`}
          >
            {busy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            {confirmLabel}
          </button>
        </>
      }
    >
      {body && <div className="text-xs font-medium leading-relaxed text-gray-800">{body}</div>}
      {Boolean(requireReason) && (
        <label className="mt-3 block">
          <span className="mb-1 block text-xs font-extrabold uppercase">{reasonLabel || "Reason"}</span>
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={3}
            maxLength={500}
            className="input-stark w-full text-base sm:text-xs"
          />
        </label>
      )}
    </Modal>
  );
}

/**
 * ConfirmDialog — use instead of window.confirm(). With `requireReason` the
 * confirm button stays disabled until a reason is typed; `onConfirm(reason)`.
 */
export default function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = "CONFIRM",
  cancelLabel = "CANCEL",
  danger = false,
  busy = false,
  requireReason = false,
  reasonLabel,
  onConfirm,
  onCancel,
}) {
  if (!open) return null;
  return (
    <ConfirmBody
      title={title}
      body={body}
      confirmLabel={confirmLabel}
      cancelLabel={cancelLabel}
      danger={danger}
      busy={busy}
      requireReason={requireReason}
      reasonLabel={reasonLabel}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
