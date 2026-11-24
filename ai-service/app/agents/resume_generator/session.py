"""In-process session store for the Resume Generator Agent.

Uses a plain Python dict keyed by ``sessionId``.  This is intentionally
simple and consistent with the rest of the project — which has no external
persistence layer.  When the project adds a database or Redis, this file is
the single place to swap the storage backend.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from app.agents.resume_generator.schemas import (
    ResumeData,
    SectionStatus,
    SessionStatus,
)

log = logging.getLogger("resume_agent.session")

# ---------------------------------------------------------------------------
# Optional sections that the agent may ask about / skip
# ---------------------------------------------------------------------------

OPTIONAL_SECTIONS: List[str] = [
    "achievements",
    "certifications",
    "positions",
    "languages",
]

# Sections that MUST be filled before we can generate a resume
REQUIRED_SECTIONS: List[str] = [
    "personal",
    "education",
]


# ---------------------------------------------------------------------------
# Session state dataclass
# ---------------------------------------------------------------------------


@dataclass
class ResumeSessionState:
    """All state associated with one resume-building / editing session."""

    # What phase the session is in
    status: SessionStatus = SessionStatus.COLLECTING

    # Structured resume content (the source of truth)
    resume: ResumeData = field(default_factory=ResumeData)

    # Disposition of optional sections
    section_flags: Dict[str, SectionStatus] = field(
        default_factory=lambda: {s: SectionStatus.UNKNOWN for s in OPTIONAL_SECTIONS}
    )

    # LLM conversation history — list of {"role": "user"|"model", "parts": [{"text": "..."}]}
    history: List[Dict[str, Any]] = field(default_factory=list)

    # Last generated LaTeX (empty until first generation)
    latex: str = ""

    # Job selected in the shared student journey. It is retained across short
    # follow-ups such as "yes, generate" and post-generation edits.
    target_job: Optional[Dict[str, Any]] = None

    # Tracks which required section we are currently asking about
    current_section: str = "personal"

    # Whether experience / projects have been provided (non-optional but
    # conversationally collected)
    has_experience: bool = False
    has_projects: bool = False
    has_skills: bool = False

    # Whether the user was asked the "anything else?" question
    extra_asked: bool = False

    # Compaction state — managed exclusively by compactor.py
    # A concise LLM-generated summary of older history turns.
    conversation_summary: str = ""
    # Total number of history entries that have been compacted (for logging).
    compacted_turns_count: int = 0

    def section_status(self, section: str) -> SectionStatus:
        return self.section_flags.get(section, SectionStatus.UNKNOWN)

    def mark_section(self, section: str, status: SectionStatus) -> None:
        if section in self.section_flags:
            self.section_flags[section] = status
            log.debug("section %s → %s", section, status.value)

    def append_history(self, role: str, text: str) -> None:
        """Append one turn to the LLM conversation history."""
        self.history.append({"role": role, "parts": [{"text": text}]})

    def is_ready_to_generate(self) -> bool:
        """True when all required sections are filled and main optional sections decided."""
        has_personal = bool(
            self.resume.personal.name or self.resume.personal.email
        )
        has_education = bool(self.resume.education)
        core_done = has_personal and has_education and self.has_skills
        optionals_decided = all(
            self.section_flags[s] != SectionStatus.UNKNOWN
            for s in OPTIONAL_SECTIONS
        )
        return core_done and (self.has_experience or self.has_projects) and (optionals_decided or self.extra_asked)


# ---------------------------------------------------------------------------
# Process-level store
# ---------------------------------------------------------------------------

_SESSIONS: Dict[str, ResumeSessionState] = {}


def get_or_create_session(session_id: str) -> ResumeSessionState:
    """Return the existing session for *session_id*, or create a fresh one."""
    if session_id not in _SESSIONS:
        log.info("creating new resume session: %s", session_id)
        _SESSIONS[session_id] = ResumeSessionState()
    return _SESSIONS[session_id]


def save_session(session_id: str, state: ResumeSessionState) -> None:
    """Persist (upsert) *state* back into the store."""
    _SESSIONS[session_id] = state


def delete_session(session_id: str) -> None:
    """Remove a session (e.g. on explicit reset)."""
    _SESSIONS.pop(session_id, None)
