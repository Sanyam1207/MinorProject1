"""Copilot wire format (AGENT-TOOLS.md §6, PYTHON.md §5.2) and per-turn state.

Every chunk's ``response`` is the complete markdown to render (never a delta)
and its ``data`` carries the cumulative ``tool_calls`` and ``ui_actions`` of
the request, deep-copied at emission time.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from app.agents.base import AgentChunk

THINKING_TEXT = "_Thinking…_"
NO_TOOLS_TEXT = (
    "I can't reach your campus data right now because the assistant isn't connected to the server. "
    "Please try again later."
)
UNREACHABLE_TEXT = "I can't reach the campus services right now. Please try again in a minute."
CANCELLED_TEXT = "Okay, I won't do that. Nothing was changed."
EXPIRED_TEXT = "That confirmation expired, so I didn't do anything. Ask me again if you still want it."
CONFIRM_PREFIX = "**Please confirm:** "
BLOCKED_TEXT = "Sorry, I can't help with that request."
FALLBACK_UNKNOWN = "I'm not sure how to help with that yet."
GENERIC_ERROR = "Something went wrong on my side. Please try again."
CONFIRM_AGAIN_TEXT = "I couldn't complete that: the server asked for confirmation again."
CONFIRM_OPTIONS = ["Confirm", "Cancel"]
MAX_OPTIONS = 6

STATUS_WORDS = {
    "running": "working…",
    "done": "done",
    "error": "failed",
    "needs_confirmation": "needs your confirmation",
}


def humanize(name: str) -> str:
    """``attendance_my_summary`` -> ``Attendance my summary``."""
    words = " ".join(str(name or "").replace("_", " ").split())
    return words[:1].upper() + words[1:] if words else "Tool"


@dataclass
class TurnState:
    """Everything the copilot has done in one request (one user turn)."""

    request_id: str
    source: str = "llm"                       # llm | planner | confirm | system
    tool_calls: List[Dict[str, Any]] = field(default_factory=list)
    ui_actions: List[Dict[str, Any]] = field(default_factory=list)
    results: Dict[str, Any] = field(default_factory=dict)   # tool_call id -> ToolResult
    _counter: int = 0

    def start_call(self, name: str, args: Optional[dict]) -> Dict[str, Any]:
        self._counter += 1
        call = {
            "id": f"tc{self._counter}",
            "name": str(name),
            "args": copy.deepcopy(args) if isinstance(args, dict) else {},
            "status": "running",
        }
        self.tool_calls.append(call)
        return call

    def finish_call(self, call: Dict[str, Any], result: Any, *, with_ui: bool = True) -> None:
        """Record a ToolResult: status, summary/message, error code and (unless reused) its ui actions."""
        self.results[call["id"]] = result
        if getattr(result, "ok", False):
            call["status"] = "done"
            call.pop("error", None)
            if getattr(result, "summary", ""):
                call["summary"] = result.summary
            if with_ui:
                self.add_ui(call["id"], getattr(result, "ui", None) or [])
        else:
            call["status"] = "error"
            call["error"] = getattr(result, "error", None) or "ERROR"
            message = getattr(result, "message", "")
            if message:
                call["summary"] = message

    def fail_call(self, call: Dict[str, Any], code: str, message: str = "") -> None:
        call["status"] = "error"
        call["error"] = code or "ERROR"
        if message:
            call["summary"] = message

    def mark_needs_confirmation(self, call: Dict[str, Any], preview: str) -> None:
        call["status"] = "needs_confirmation"
        call["summary"] = preview

    def add_ui(self, tool_call_id: str, ui_list: List[Dict[str, Any]]) -> None:
        for index, ui in enumerate(ui_list, 1):
            if not isinstance(ui, dict) or not isinstance(ui.get("panel"), str) or not ui["panel"]:
                continue
            action: Dict[str, Any] = {
                "id": f"{tool_call_id}:{index}",
                "panel": ui["panel"],
                "params": copy.deepcopy(ui.get("params")) if isinstance(ui.get("params"), dict) else {},
            }
            if "data" in ui:
                action["data"] = copy.deepcopy(ui["data"])
            self.ui_actions.append(action)

    def progress_markdown(self) -> str:
        return "\n".join(
            f"- {humanize(call['name'])} — {STATUS_WORDS.get(call['status'], call['status'])}"
            for call in self.tool_calls
        )

    def data(self, phase: str, **extra: Any) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "type": "copilot",
            "phase": phase,
            "tool_calls": copy.deepcopy(self.tool_calls),
            "ui_actions": copy.deepcopy(self.ui_actions),
            "source": self.source,
        }
        payload.update(copy.deepcopy(extra))
        return payload


class CopilotChunk(AgentChunk):
    """One copilot payload; the orchestrator emits it verbatim."""

    __slots__ = ("header_message", "response", "data", "is_end", "options", "session_id", "confidence_score")

    HEADER_THINKING = "copilot:thinking"
    HEADER_TOOL = "copilot:tool"
    HEADER_ANSWER = "copilot:answer"
    HEADER_CONFIRM = "copilot:confirm"
    HEADER_ERROR = "copilot:error"
    HEADERS = (HEADER_THINKING, HEADER_TOOL, HEADER_ANSWER, HEADER_CONFIRM, HEADER_ERROR)

    def __init__(
        self,
        *,
        header_message: str,
        response: str,
        data: Dict[str, Any],
        is_end: bool,
        options: Optional[List[str]] = None,
        session_id: str = "",
    ) -> None:
        self.header_message = header_message
        self.response = response
        self.data = data
        self.is_end = is_end
        self.options = list(options) if options else None
        self.session_id = session_id
        self.confidence_score = None

    @classmethod
    def thinking(cls, turn: TurnState) -> "CopilotChunk":
        return cls(header_message=cls.HEADER_THINKING, response=THINKING_TEXT, data=turn.data("thinking"), is_end=False)

    @classmethod
    def tool(cls, turn: TurnState) -> "CopilotChunk":
        return cls(
            header_message=cls.HEADER_TOOL,
            response=turn.progress_markdown() or THINKING_TEXT,
            data=turn.data("tool"),
            is_end=False,
        )

    @classmethod
    def answer(cls, turn: TurnState, text: str, options: Optional[List[str]] = None) -> "CopilotChunk":
        cleaned = [str(option) for option in (options or []) if str(option).strip()][:MAX_OPTIONS]
        return cls(
            header_message=cls.HEADER_ANSWER,
            response=(text or "").strip() or FALLBACK_UNKNOWN,
            data=turn.data("answer"),
            is_end=True,
            options=cleaned or None,
        )

    @classmethod
    def confirm(cls, turn: TurnState, pending: Any) -> "CopilotChunk":
        pending_data = {"tool": pending.tool, "args": pending.args, "preview": pending.preview}
        return cls(
            header_message=cls.HEADER_CONFIRM,
            response=CONFIRM_PREFIX + pending.preview,
            data=turn.data("confirm", pending=pending_data),
            is_end=True,
            options=list(CONFIRM_OPTIONS),
        )

    @classmethod
    def error(cls, message: str, turn: Optional[TurnState] = None) -> "CopilotChunk":
        data = {
            "type": "copilot",
            "phase": "error",
            "message": message,
            "tool_calls": copy.deepcopy(turn.tool_calls) if turn else [],
            "ui_actions": copy.deepcopy(turn.ui_actions) if turn else [],
            "source": turn.source if turn else "system",
        }
        return cls(header_message=cls.HEADER_ERROR, response=message, data=data, is_end=True)
