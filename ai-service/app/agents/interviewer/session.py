"""In-process session store for the AI Interviewer Agent.

Keyed by ``sessionId``, same as the resume and job-creation agents.  Unlike
those two this store prunes itself: an interview holds a full transcript and
is strictly time-boxed, so stale sessions are dropped on access rather than
being kept until the process restarts.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from app.config import settings
from app.agents.interviewer.schemas import (
    InterviewReport,
    InterviewSource,
    InterviewStage,
    JobContext,
    ProfileContext,
    QAPair,
)

log = logging.getLogger("interviewer.session")


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# Session state
# ---------------------------------------------------------------------------


@dataclass
class InterviewSessionState:
    """All state associated with one mock-interview conversation."""

    # -- workflow ---------------------------------------------------------
    stage: InterviewStage = InterviewStage.CHOOSING
    source: Optional[InterviewSource] = None

    # -- interview material ----------------------------------------------
    job: Optional[JobContext] = None
    profile: Optional[ProfileContext] = None
    extra_conditions: str = ""

    # -- candidate --------------------------------------------------------
    candidate_name: str = ""

    # -- transcript -------------------------------------------------------
    qa: List[QAPair] = field(default_factory=list)
    pending_question: Optional[QAPair] = None

    # -- timing -----------------------------------------------------------
    started_at: Optional[datetime] = None
    last_active: datetime = field(default_factory=_now)

    # -- pending mode switch ----------------------------------------------
    # Set when the router thinks the candidate wants another agent but the
    # message did not clearly read as leaving. Rather than guess, the agent
    # asks, and remembers what to switch to if the answer is yes.
    awaiting_switch_confirmation: bool = False
    pending_switch_target: str = ""
    pending_switch_query: str = ""
    declined_switch: bool = False

    # -- outcome ----------------------------------------------------------
    report: Optional[InterviewReport] = None
    ended_reason: str = ""

    # -- helpers ----------------------------------------------------------

    def touch(self) -> None:
        self.last_active = _now()

    def reset(self) -> None:
        """Clear this session back to a fresh interview, in place.

        In place matters: ``run()`` saves the state object it was handed when
        the turn finishes, so swapping in a different object mid-turn would be
        overwritten the moment that save runs.
        """
        self.stage = InterviewStage.CHOOSING
        self.source = None
        self.job = None
        self.profile = None
        self.extra_conditions = ""
        self.candidate_name = ""
        self.qa = []
        self.pending_question = None
        self.started_at = None
        self.report = None
        self.ended_reason = ""
        self.declined_switch = False
        self.clear_pending_switch()
        self.touch()

    def clear_pending_switch(self) -> None:
        self.awaiting_switch_confirmation = False
        self.pending_switch_target = ""
        self.pending_switch_query = ""

    def start_clock(self) -> None:
        """Start the 10-minute budget on the first question asked."""
        if self.started_at is None:
            self.started_at = _now()

    def elapsed_seconds(self) -> float:
        if self.started_at is None:
            return 0.0
        return (_now() - self.started_at).total_seconds()

    def seconds_remaining(self) -> int:
        if self.started_at is None:
            return settings.INTERVIEW_MAX_SECONDS
        left = settings.INTERVIEW_MAX_SECONDS - self.elapsed_seconds()
        return max(0, int(left))

    def is_time_up(self) -> bool:
        return self.started_at is not None and self.elapsed_seconds() >= settings.INTERVIEW_MAX_SECONDS

    def duration_minutes(self) -> float:
        return round(self.elapsed_seconds() / 60.0, 2)

    def role_label(self) -> str:
        if self.source == InterviewSource.JOB and self.job is not None:
            return self.job.headline()
        if self.profile is not None:
            return self.profile.headline()
        return "General"

    def answered_pairs(self) -> List[QAPair]:
        """Only the questions that actually received an answer."""
        return [pair for pair in self.qa if pair.answer.strip()]

    def record_answer(self, answer: str) -> None:
        """Attach *answer* to the question currently awaiting one."""
        if self.pending_question is None:
            return
        self.pending_question.answer = answer.strip()
        self.qa.append(self.pending_question)
        self.pending_question = None

    def transcript(self) -> str:
        """Readable transcript for the question-generation / report prompts."""
        lines: List[str] = []
        for i, pair in enumerate(self.qa, start=1):
            lines.append(f"Q{i} [{pair.topic}]: {pair.question}")
            lines.append(f"A{i}: {pair.answer or '(no answer given)'}")
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# Process-level store (self-pruning)
# ---------------------------------------------------------------------------

_SESSIONS: Dict[str, InterviewSessionState] = {}


def _prune() -> None:
    """Drop sessions idle beyond the TTL, then cap the store size.

    Called on every access -- an interview session carries a full transcript,
    so leaving them to accumulate for the life of the process is not viable.
    """
    ttl = timedelta(seconds=settings.INTERVIEW_SESSION_TTL_SECONDS)
    cutoff = _now() - ttl
    stale = [key for key, state in _SESSIONS.items() if state.last_active < cutoff]
    for key in stale:
        _SESSIONS.pop(key, None)
    if stale:
        log.info("pruned %d idle interview session(s)", len(stale))

    overflow = len(_SESSIONS) - settings.INTERVIEW_MAX_SESSIONS
    if overflow > 0:
        oldest = sorted(_SESSIONS.items(), key=lambda kv: kv[1].last_active)[:overflow]
        for key, _ in oldest:
            _SESSIONS.pop(key, None)
        log.warning("interview session cap reached -- evicted %d oldest session(s)", overflow)


def get_or_create_session(session_id: str) -> InterviewSessionState:
    """Return the existing session for *session_id*, or create a fresh one."""
    _prune()
    key = session_id or "default"
    state = _SESSIONS.get(key)
    if state is None:
        log.info("creating new interview session: %s", key)
        state = InterviewSessionState()
        _SESSIONS[key] = state
    state.touch()
    return state


def save_session(session_id: str, state: InterviewSessionState) -> None:
    """Persist (upsert) *state* back into the store."""
    state.touch()
    _SESSIONS[session_id or "default"] = state


def delete_session(session_id: str) -> None:
    """Remove a session (explicit reset, or after the report is delivered)."""
    _SESSIONS.pop(session_id or "default", None)


def reset_session(session_id: str) -> InterviewSessionState:
    """Clear the session for *session_id* and return it, ready for a new run.

    Resets the existing object rather than replacing it, so any caller already
    holding a reference to it sees the reset too.
    """
    state = get_or_create_session(session_id)
    state.reset()
    save_session(session_id, state)
    return state
