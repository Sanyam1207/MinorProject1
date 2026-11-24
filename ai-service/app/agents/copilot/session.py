"""Per-session copilot memory: one pending confirmation and one awaited input.

* ``PendingAction`` -- a side-effecting tool call Node asked the user to
  confirm. The next turn's "Confirm"/"Cancel" resolves it; anything else drops
  it. It expires after ``COPILOT_CONFIRM_TTL_SECONDS`` but is kept a while
  longer so a late "yes" gets an honest "that expired" instead of a guess.
* ``AwaitingInput`` -- the planner asked for a missing argument ("Which
  course?") or a choice between AMBIGUOUS candidates.

Keyed by ``req.sessionId`` (``<userId>:<browserSessionId>``).
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Callable, List, Optional, Tuple

from app.config import settings
from app.utils.ttl_store import TTLStore


@dataclass
class PendingAction:
    tool: str
    args: dict
    preview: str
    created_at: float = 0.0
    request_id: str = ""


@dataclass
class AwaitingInput:
    tool: str
    args: dict
    arg: str
    candidates: Optional[List[dict]] = None
    created_at: float = 0.0


@dataclass
class _Entry:
    pending: Optional[PendingAction] = None
    awaiting: Optional[AwaitingInput] = None


class CopilotSessionStore:
    def __init__(self, *, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._store: TTLStore[_Entry] = TTLStore(
            "copilot",
            ttl_seconds=lambda: float(settings.COPILOT_CONFIRM_TTL_SECONDS) + 3600.0,
            max_items=lambda: settings.AGENT_MAX_SESSIONS,
            clock=self._call_clock,
        )

    def _call_clock(self) -> float:
        return self._clock()

    def now(self) -> float:
        return self._clock()

    def set_clock(self, clock: Callable[[], float]) -> None:
        """Tests: swap the clock (also used by the underlying TTL store)."""
        self._clock = clock

    def _expired(self, created_at: float) -> bool:
        return self._clock() - created_at > float(settings.COPILOT_CONFIRM_TTL_SECONDS)

    def _entry(self, sid: str) -> _Entry:
        return self._store.get_or_create(sid, _Entry)

    def set_pending(self, sid: str, action: PendingAction) -> None:
        """Replace any previous pending action; clears an awaited input.

        A request without a session id never stores anything (it would be shared).
        """
        if not sid:
            return
        if not action.created_at:
            action.created_at = self._clock()
        entry = self._entry(sid)
        entry.pending = action
        entry.awaiting = None
        self._store.set(sid, entry)

    def peek_pending(self, sid: str) -> Tuple[Optional[PendingAction], bool]:
        """``(action, expired?)`` without removing it."""
        entry = self._store.get(sid)
        if entry is None or entry.pending is None:
            return None, False
        return entry.pending, self._expired(entry.pending.created_at)

    def has_pending(self, sid: str) -> bool:
        """True for fresh AND expired-but-kept pending actions."""
        entry = self._store.get(sid)
        return bool(entry and entry.pending is not None)

    def clear_pending(self, sid: str) -> None:
        entry = self._store.get(sid)
        if entry is not None:
            entry.pending = None

    def set_awaiting(self, sid: str, awaiting: AwaitingInput) -> None:
        if not sid:
            return
        if not awaiting.created_at:
            awaiting.created_at = self._clock()
        entry = self._entry(sid)
        entry.awaiting = awaiting
        entry.pending = None
        self._store.set(sid, entry)

    def take_awaiting(self, sid: str) -> Optional[AwaitingInput]:
        """Remove and return the awaited input; None when absent or expired."""
        entry = self._store.get(sid)
        if entry is None or entry.awaiting is None:
            return None
        awaiting, entry.awaiting = entry.awaiting, None
        if self._expired(awaiting.created_at):
            return None
        return awaiting

    def clear(self, sid: str) -> None:
        self._store.pop(sid)

    def reset(self) -> None:
        """Tests only."""
        self._store.clear()


store = CopilotSessionStore()
