import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

const SIZES = { sm: "sm:max-w-sm", md: "sm:max-w-md", lg: "sm:max-w-2xl" };

// Only the top-most open dialog reacts to Escape.
const openStack = [];

/**
 * Stark dialog: full screen below `sm`, centred card above. Escape and a
 * backdrop click call `onClose` (omit `onClose` for a dialog that cannot be
 * dismissed). Rendered in a portal so transformed ancestors never clip it.
 */
export default function Modal({ open, title, onClose, children, footer, size = "md", className = "" }) {
  const titleId = useId();
  const panelRef = useRef(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return undefined;
    const token = {};
    openStack.push(token);
    const previouslyFocused = typeof document !== "undefined" ? document.activeElement : null;
    panelRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event) => {
      if (event.key === "Escape" && openStack[openStack.length - 1] === token && onCloseRef.current) {
        event.preventDefault();
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      const index = openStack.indexOf(token);
      if (index !== -1) openStack.splice(index, 1);
      if (previouslyFocused && typeof previouslyFocused.focus === "function") previouslyFocused.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="animate-fade-overlay fixed inset-0 z-[60] flex items-stretch justify-center bg-black/50 sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose?.();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`card-stark animate-fadeIn flex h-full w-full flex-col overflow-hidden p-0 outline-none sm:h-auto sm:max-h-[90vh] ${SIZES[size] ?? SIZES.md} ${className}`}
      >
        <div className="flex items-center justify-between gap-3 border-b-2 border-black px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:pt-3">
          <h2 id={titleId} className="min-w-0 truncate text-sm font-black uppercase">
            {title}
          </h2>
          {onClose && (
            <button type="button" onClick={onClose} aria-label="Close" className="btn-secondary shrink-0 p-1.5">
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t-2 border-black px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pb-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
