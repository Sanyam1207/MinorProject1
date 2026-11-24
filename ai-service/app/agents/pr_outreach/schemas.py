"""Pydantic models and sentinel chunk used by the PR Outreach Agent.

``PROutreachChunk`` is the sentinel object the agent yields.
The orchestrator detects it with ``isinstance(item, PROutreachChunk)`` and
emits it directly, bypassing all job-scraping accumulation logic — exactly
the same pattern as ``ResumeChunk`` and ``JobCreationChunk``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from app.agents.base import AgentChunk


# ---------------------------------------------------------------------------
# Conversation phase
# ---------------------------------------------------------------------------


class OutreachPhase:
    """Constants for the outreach workflow phases."""
    COLLECTING_EMAIL = "collecting_email"
    COLLECTING_PURPOSE = "collecting_purpose"
    DRAFTING = "drafting"
    SATISFIED = "satisfied"


# ---------------------------------------------------------------------------
# Structured email data
# ---------------------------------------------------------------------------


@dataclass
class EmailDraft:
    """The finished email object returned to the frontend."""
    subject: str = ""
    to: str = ""
    body: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "subject": self.subject,
            "to": self.to,
            "body": self.body,
        }


# ---------------------------------------------------------------------------
# Sentinel chunk yielded by the agent — detected by the orchestrator
# ---------------------------------------------------------------------------


class PROutreachChunk(AgentChunk):
    """A single output unit from the PR Outreach Agent.

    The orchestrator checks ``isinstance(item, PROutreachChunk)`` and emits
    the payload directly without any job-scraping post-processing.

    Attributes
    ----------
    header_message: ``"pr_outreach"`` while collecting context,
                    ``"pr_outreach_satisfied"`` when the agent has enough
                    context, or ``"mail:review"`` when sending the draft UI.
    response:       Human-readable message for the chat panel.
    data:           Structured payload (email draft) for the frontend.
    is_end:         True only on the very last chunk of a request.
    confidence_score: Agent's confidence in the drafted email (0.0–1.0).
    options:        Optional list of quick-reply strings for the frontend.
    """

    __slots__ = (
        "header_message", "response", "data", "is_end",
        "confidence_score", "options",
    )

    HEADER_IN_PROGRESS = "pr_outreach"
    HEADER_SATISFIED = "pr_outreach_satisfied"
    HEADER_REVIEW = "mail:review"
    HEADER_COMPLETED = "pr_outreach_completed"

    def __init__(
        self,
        *,
        header_message: str,
        response: str = "",
        data: Optional[Dict[str, Any]] = None,
        is_end: bool = False,
        confidence_score: Optional[float] = None,
        options: Optional[List[str]] = None,
    ) -> None:
        self.header_message = header_message
        self.response = response
        self.data = data or {}
        self.is_end = is_end
        self.confidence_score = confidence_score
        self.options = options

    # ── Convenience constructors ─────────────────────────────────────────────

    @classmethod
    def question_chunk(
        cls,
        *,
        response: str,
        options: Optional[List[str]] = None,
        is_end: bool = True,
    ) -> "PROutreachChunk":
        """Chunk that asks the user a follow-up question."""
        return cls(
            header_message=cls.HEADER_IN_PROGRESS,
            response=response,
            is_end=is_end,
            options=options,
        )

    @classmethod
    def draft_chunk(
        cls,
        *,
        response: str,
        email: EmailDraft,
        confidence_score: float,
        is_end: bool = True,
    ) -> "PROutreachChunk":
        """Send the structured email to the frontend review composer."""
        return cls(
            header_message=cls.HEADER_REVIEW,
            response=response,
            data=email.to_dict(),
            is_end=is_end,
            confidence_score=confidence_score,
        )

    @classmethod
    def satisfied_chunk(
        cls,
        *,
        confidence_score: float,
        is_end: bool = False,
    ) -> "PROutreachChunk":
        """Signal that the agent is satisfied it has enough drafting context."""
        return cls(
            header_message=cls.HEADER_SATISFIED,
            response="I have enough context to prepare the outreach email.",
            data={"status": "satisfied"},
            is_end=is_end,
            confidence_score=confidence_score,
        )

    @classmethod
    def error_chunk(
        cls,
        *,
        response: str,
    ) -> "PROutreachChunk":
        """Chunk for non-fatal errors."""
        return cls(
            header_message=cls.HEADER_IN_PROGRESS,
            response=response,
            data={"type": "error"},
            is_end=True,
        )

    @classmethod
    def completion_chunk(cls) -> "PROutreachChunk":
        """Acknowledge delivery after clearing the session's internal state."""
        return cls(
            header_message=cls.HEADER_COMPLETED,
            response="Great — the mail was sent and the final format was accepted. I have cleared this outreach session's draft context.",
            data={"status": "completed", "session_cleared": True},
            is_end=True,
        )
