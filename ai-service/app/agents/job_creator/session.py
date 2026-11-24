"""In-process session store for the Job Creation Agent.

A ``TTLStore`` keyed by ``sessionId``: idle sessions expire after
``AGENT_SESSION_TTL_SECONDS`` and at most ``AGENT_MAX_SESSIONS`` are kept
(least recently used evicted). If the project later adds a database or
Redis, this file is the single place to swap.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from app.config import settings
from app.agents.job_creator.schemas import JobData, JobStatus
from app.utils.ttl_store import TTLStore

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

    # ── Identity of the draft being built (Node upserts on it) ──────────────
    draft_id: str = field(default_factory=lambda: uuid.uuid4().hex)

    def append_history(self, role: str, text: str) -> None:
        """Append one turn to the LLM conversation history."""
        self.history.append({"role": role, "parts": [{"text": text}]})

    def reset_after_post(self) -> None:
        """Start a fresh draft once a job has been posted (a later "post it"
        can then never re-post the same job). Institutional context is kept."""
        self.job = JobData()
        self.status = JobStatus.DATA
        self.awaiting_confirmation = False
        self.missing_fields = []
        self.history = []
        self.conversation_summary = ""
        self.compacted_turns_count = 0
        self.draft_id = uuid.uuid4().hex


# ---------------------------------------------------------------------------
# Process-level store
# ---------------------------------------------------------------------------

_SESSIONS: TTLStore[JobSessionState] = TTLStore(
    "job-creator",
    ttl_seconds=lambda: settings.AGENT_SESSION_TTL_SECONDS,
    max_items=lambda: settings.AGENT_MAX_SESSIONS,
)


def get_or_create_session(session_id: str) -> JobSessionState:
    """Return the existing session for *session_id*, or create a fresh one."""
    session = _SESSIONS.get(session_id)
    if session is None:
        log.info("creating new job-creation session")
        session = JobSessionState()
        _SESSIONS.set(session_id, session)
    return session


def save_session(session_id: str, state: JobSessionState) -> None:
    """Persist (upsert) *state* back into the store."""
    _SESSIONS.set(session_id, state)


def delete_session(session_id: str) -> None:
    """Remove a session (e.g. on explicit reset)."""
    _SESSIONS.pop(session_id, None)
