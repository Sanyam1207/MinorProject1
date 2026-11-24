import { RotateCcw, TriangleAlert } from "lucide-react";
import { errorMessage } from "../lib/http.js";

export default function ErrorState({ error, title = "SOMETHING WENT WRONG", onRetry, retryLabel = "TRY AGAIN" }) {
  const message = typeof error === "string" ? error : errorMessage(error, "Please try again in a moment.");
  return (
    <div role="alert" className="border-2 border-black bg-red-50 p-5 text-center">
      <TriangleAlert className="mx-auto mb-2 h-7 w-7 text-red-700" aria-hidden="true" />
      <div className="text-xs font-black uppercase">{title}</div>
      <p className="mx-auto mt-1 max-w-md break-words text-[11px] font-semibold text-gray-700">{message}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="btn-primary mt-3 min-h-11 px-3 py-1.5 text-xs sm:min-h-0">
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          {retryLabel}
        </button>
      )}
    </div>
  );
}
