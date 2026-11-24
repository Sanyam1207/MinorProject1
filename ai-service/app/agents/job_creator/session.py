"""In-process session store for the Job Creation Agent.

Uses a plain Python dict keyed by ``sessionId``.  Consistent with the
rest of the project — no external persistence layer.  If the project
later adds a database or Redis, this file is the single place to swap.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from app.agents.job_creator.schemas import JobData, JobStatus

log = logging.getLogger("job_creator.session")


# ---------------------------------------------------------------------------
# Session state dataclass
# ---------------------------------------------------------------------------


@dataclass
class JobSessionState:
    """All state associated with one job-creation conversation."""

    # ── Workflow state ───────────────────────────────────────────────────────
    # Current workflow status (DATA / READY / POST)
    status: JobStatus = JobStatus.DATA

    # Whether we are waiting for the TPO to confirm posting
    awaiting_confirmation: bool = False

    # ── Structured job state (the source of truth) ────────────────────────
    job: JobData = field(default_factory=JobData)

    # Mandatory fields currently missing — recomputed after every update
    missing_fields: List[str] = field(default_factory=list)

    # ── Conversational context ─────────────────────────────────────────────
    # LLM conversation history: list of {"role": "user"|"model", "parts": [{"text": "..."}]}
    history: List[Dict[str, Any]] = field(default_factory=list)

    # ── Compaction state (managed exclusively by compactor.py) ─────────────
    # A concise LLM-generated summary of older history turns.
    conversation_summary: str = ""
    # Total number of history entries that have been compacted (for logging).
    compacted_turns_count: int = 0

    # ── Institutional context (set once from meta_data) ────────────────────
    college_name: str = ""
    available_branches: List[str] = field(default_factory=list)

    def append_history(self, role: str, text: str) -> None:
        """Append one turn to the LLM conversation history."""
        self.history.append({"role": role, "parts": [{"text": text}]})


# ---------------------------------------------------------------------------
# Process-level store
# ---------------------------------------------------------------------------

_SESSIONS: Dict[str, JobSessionState] = {}


def get_or_create_session(session_id: str) -> JobSessionState:
    """Return the existing session for *session_id*, or create a fresh one."""
    if session_id not in _SESSIONS:
        log.info("creating new job-creation session: %s", session_id)
        _SESSIONS[session_id] = JobSessionState()
    return _SESSIONS[session_id]


def save_session(session_id: str, state: JobSessionState) -> None:
    """Persist (upsert) *state* back into the store."""
    _SESSIONS[session_id] = state


def delete_session(session_id: str) -> None:
    """Remove a session (e.g. on explicit reset)."""
    _SESSIONS.pop(session_id, None)
