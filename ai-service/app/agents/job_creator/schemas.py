"""Pydantic models, enums, and sentinel chunk used by the Job Creation Agent.

``JobCreationChunk`` is the sentinel object that the agent yields.
The orchestrator detects it with ``isinstance(item, JobCreationChunk)`` and
emits it directly, bypassing all job-scraping accumulation logic — exactly
the same pattern as ``ResumeChunk``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional

from app.agents.base import AgentChunk


# ---------------------------------------------------------------------------
# Status enums
# ---------------------------------------------------------------------------


class JobStatus(str, Enum):
    """Workflow phase of the current job-creation session."""
    DATA = "data"        # Collecting / editing — mandatory fields incomplete
    READY = "ready"      # All mandatory fields valid; may be awaiting confirmation
    POST = "post"        # User confirmed posting


# ---------------------------------------------------------------------------
# Structured job data (source of truth — never replaced by a summary)
# ---------------------------------------------------------------------------


@dataclass
class JobData:
    """All fields the agent manages for a single job posting."""

    # ── Mandatory fields ────────────────────────────────────────────────────
    company_name: str = ""
    job_role: str = ""
    job_description: str = ""
    app_deadline: str = ""           # ISO 8601 with timezone, e.g. 2026-08-30T17:00:00+05:30

    # ── Optional fields with sensible defaults ───────────────────────────────
    salary: str = "not disclosed"
    eligible_branches: List[str] = field(default_factory=list)
    location: str = ""
    employment_type: str = ""
    minimum_cgpa: str = ""
    maximum_backlogs: str = ""
    graduation_years: List[str] = field(default_factory=list)
    skills: List[str] = field(default_factory=list)
    selection_process: str = ""

    def to_dict(self) -> Dict[str, Any]:
        """Return a plain dict representation for JSON serialisation."""
        return {
            "company_name": self.company_name,
            "job_role": self.job_role,
            "job_description": self.job_description,
            "app_deadline": self.app_deadline,
            "salary": self.salary,
            "eligible_branches": list(self.eligible_branches),
            "location": self.location,
            "employment_type": self.employment_type,
            "minimum_cgpa": self.minimum_cgpa,
            "maximum_backlogs": self.maximum_backlogs,
            "graduation_years": list(self.graduation_years),
            "skills": list(self.skills),
            "selection_process": self.selection_process,
        }


# ---------------------------------------------------------------------------
# Sentinel yielded by the agent — detected by the orchestrator
# ---------------------------------------------------------------------------


class JobCreationChunk(AgentChunk):
    """A single output unit from the Job Creation Agent.

    The orchestrator checks ``isinstance(item, JobCreationChunk)`` and emits
    the payload directly without any job-scraping post-processing.

    Attributes
    ----------
    header_message: One of ``mode:jobCreation:data``, ``mode:jobCreation:ready``,
                    ``mode:jobCreation:post`` or ``mode:jobCreation:error``.
    response:       Human-readable message for the chat panel.
    data:           Structured payload for the frontend's job-creation UI.
    is_end:         True only on the very last chunk of a request.
    session_id:     The session this chunk belongs to.
    """

    __slots__ = ("header_message", "response", "data", "is_end", "session_id")

    # Frontend-facing header constants
    HEADER_DATA = "mode:jobCreation:data"
    HEADER_READY = "mode:jobCreation:ready"
    HEADER_POST = "mode:jobCreation:post"
    HEADER_ERROR = "mode:jobCreation:error"

    def __init__(
        self,
        *,
        header_message: str,
        response: str = "",
        data: Optional[Dict[str, Any]] = None,
        is_end: bool = False,
        session_id: str = "",
    ) -> None:
        self.header_message = header_message
        self.response = response
        self.data = data or {}
        self.is_end = is_end
        self.session_id = session_id

    # ── Convenience constructors ─────────────────────────────────────────────

    @classmethod
    def data_chunk(
        cls,
        *,
        response: str,
        job: JobData,
        missing_fields: List[str],
        draft_id: str = "",
        session_id: str = "",
        is_end: bool = True,
    ) -> "JobCreationChunk":
        """Chunk for the DATA state — incomplete job, asking for more info."""
        return cls(
            header_message=cls.HEADER_DATA,
            response=response,
            data={
                "type": "job_creation",
                "status": "data",
                "job": job.to_dict(),
                "missing_fields": missing_fields,
                "draft_id": draft_id,
            },
            is_end=is_end,
            session_id=session_id,
        )

    @classmethod
    def ready_chunk(
        cls,
        *,
        response: str,
        job: JobData,
        draft_id: str = "",
        session_id: str = "",
        is_end: bool = True,
    ) -> "JobCreationChunk":
        """Chunk for the READY state — all mandatory fields valid."""
        return cls(
            header_message=cls.HEADER_READY,
            response=response,
            data={
                "type": "job_creation",
                "status": "ready",
                "job": job.to_dict(),
                "draft_id": draft_id,
            },
            is_end=is_end,
            session_id=session_id,
        )

    @classmethod
    def confirmation_chunk(
        cls,
        *,
        response: str,
        job: JobData,
        draft_id: str = "",
        session_id: str = "",
        is_end: bool = True,
    ) -> "JobCreationChunk":
        """Chunk for the awaiting-confirmation sub-state (header stays READY)."""
        return cls(
            header_message=cls.HEADER_READY,
            response=response,
            data={
                "type": "confirmation",
                "action": "post_job",
                "message": "The job is ready to be posted. Do you want to post it?",
                "job": job.to_dict(),
                "draft_id": draft_id,
                "options": [
                    {"label": "Yes", "value": "confirm"},
                    {"label": "No", "value": "cancel"},
                ],
            },
            is_end=is_end,
            session_id=session_id,
        )

    @classmethod
    def post_chunk(
        cls,
        *,
        response: str,
        job: JobData,
        draft_id: str = "",
        session_id: str = "",
        is_end: bool = True,
    ) -> "JobCreationChunk":
        """Chunk for the POST state — user confirmed, job is posted.

        Node persists ``data.job`` keyed on ``data.draft_id`` (one document per
        draft, so a second job in the same chat creates a new document).
        """
        return cls(
            header_message=cls.HEADER_POST,
            response=response,
            data={
                "type": "job_creation",
                "status": "post",
                "job": job.to_dict(),
                "draft_id": draft_id,
            },
            is_end=is_end,
            session_id=session_id,
        )

    @classmethod
    def error_chunk(
        cls,
        *,
        response: str,
        draft_id: str = "",
        session_id: str = "",
    ) -> "JobCreationChunk":
        """Chunk for non-fatal errors / authorization failures."""
        return cls(
            header_message=cls.HEADER_ERROR,
            response=response,
            data={"type": "error", "draft_id": draft_id},
            is_end=True,
            session_id=session_id,
        )
