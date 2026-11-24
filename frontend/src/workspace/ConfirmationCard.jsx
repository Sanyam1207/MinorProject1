import ReactMarkdown from "react-markdown";
import { Check, ShieldQuestion, X } from "lucide-react";
import { useNow } from "../ui/useNow.js";
import { toolLabel } from "./toolLabels.js";

const CONFIRM_TTL_MS = 10 * 60 * 1000; // the copilot keeps a pending action for 10 minutes
const CONFIRM_WORD = /^(confirm|yes|ok|go ahead|do it)\b/i;
const CANCEL_WORD = /^(cancel|no|stop)\b/i;

const inlineMarkdown = { p: ({ children }) => <span>{children}</span> };

/**
 * Copilot confirmation card (FRONTEND.md §8.4). Buttons come from the chunk's
 * `options` (["Confirm", "Cancel"] per AGENT-TOOLS.md §6), falling back to those
 * words; any other option is shown as an extra choice. Stale after 10 minutes.
 */
export default function ConfirmationCard({ pending, createdAt, options, disabled, onAnswer }) {
  const now = useNow(15000);
  const created = createdAt ? Date.parse(createdAt) : Number.NaN;
  const expired = Number.isFinite(created) && now - created > CONFIRM_TTL_MS;
  const preview = typeof pending?.preview === "string" && pending.preview.trim() ? pending.preview : null;
  const list = Array.isArray(options) ? options.map(String) : [];
  const confirmLabel = list.find((option) => CONFIRM_WORD.test(option)) ?? "Confirm";
  const cancelLabel = list.find((option) => CANCEL_WORD.test(option)) ?? "Cancel";
  const extras = list.filter((option) => option !== confirmLabel && option !== cancelLabel);

  return (
    <div className="mt-2 w-full max-w-[85%] border-2 border-black bg-yellow-50 p-2 shadow-[4px_4px_0_0_#000]">
      <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-black uppercase">
        <ShieldQuestion className="h-3.5 w-3.5" aria-hidden="true" />
        Confirm action
        {pending?.tool && <span className="badge-stark bg-white px-1 py-0 text-[9px]">{toolLabel(pending.tool)}</span>}
      </div>
      {preview && (
        <div className="mt-1.5 break-words text-xs font-semibold leading-relaxed [&_strong]:font-black">
          <ReactMarkdown components={inlineMarkdown}>{preview}</ReactMarkdown>
        </div>
      )}
      {expired ? (
        <p className="mt-2 text-[11px] font-bold text-gray-700">This request expired — ask again.</p>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" disabled={disabled} onClick={() => onAnswer(confirmLabel)} className="btn-primary min-h-11 px-3 py-1 text-[11px] uppercase disabled:opacity-50 sm:min-h-0">
            <Check className="h-3.5 w-3.5" aria-hidden="true" /> {confirmLabel}
          </button>
          <button type="button" disabled={disabled} onClick={() => onAnswer(cancelLabel)} className="btn-secondary min-h-11 px-3 py-1 text-[11px] uppercase disabled:opacity-50 sm:min-h-0">
            <X className="h-3.5 w-3.5" aria-hidden="true" /> {cancelLabel}
          </button>
          {extras.map((option) => (
            <button key={option} type="button" disabled={disabled} onClick={() => onAnswer(option)} className="btn-secondary min-h-11 px-3 py-1 text-[11px] disabled:opacity-50 sm:min-h-0">
              {option}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
