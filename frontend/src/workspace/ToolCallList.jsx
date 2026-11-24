import { CircleCheck, CircleX, LoaderCircle, ShieldQuestion } from "lucide-react";
import { toolLabel } from "./toolLabels.js";

const STATUS_STYLE = {
  running: { Icon: LoaderCircle, className: "bg-yellow-100", iconClass: "animate-spin" },
  done: { Icon: CircleCheck, className: "bg-green-100", iconClass: "" },
  error: { Icon: CircleX, className: "bg-red-100", iconClass: "" },
  needs_confirmation: { Icon: ShieldQuestion, className: "bg-blue-100", iconClass: "" },
};

const detailFor = (call) => {
  if (call.status === "running") return "…";
  if (call.status === "needs_confirmation") return "awaiting confirmation";
  if (call.status === "error") return call.error || "failed";
  return call.summary || "";
};

/** Copilot tool-call chips under a bot message (FRONTEND.md §8.4). */
export default function ToolCallList({ toolCalls }) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return null;
  return (
    <ul className="mt-1.5 flex w-full max-w-[85%] flex-col gap-1" aria-label="Tool calls">
      {toolCalls.map((call, index) => {
        const style = STATUS_STYLE[call.status] ?? STATUS_STYLE.done;
        const { Icon } = style;
        const detail = detailFor(call);
        return (
          <li
            key={call.id ?? index}
            className={`flex min-w-0 items-center gap-1.5 border border-black px-1.5 py-1 text-[10px] font-bold ${style.className}`}
          >
            <Icon className={`h-3.5 w-3.5 shrink-0 ${style.iconClass}`} aria-hidden="true" />
            <span className="shrink-0 uppercase">{toolLabel(call.name)}</span>
            {detail && (
              <span className="min-w-0 truncate font-semibold text-gray-700" title={detail}>
                {call.status === "running" ? detail : `· ${detail}`}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
