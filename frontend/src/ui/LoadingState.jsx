import { Sparkles } from "lucide-react";

export default function LoadingState({ label = "LOADING…", className = "" }) {
  return (
    <div role="status" aria-live="polite" className={`flex w-full items-center justify-center p-6 ${className}`}>
      <span className="inline-flex items-center gap-2 border-2 border-black bg-yellow-100 px-3 py-1.5 text-xs font-black uppercase tracking-wide">
        <Sparkles className="h-4 w-4 animate-spin" aria-hidden="true" />
        {label}
      </span>
    </div>
  );
}
