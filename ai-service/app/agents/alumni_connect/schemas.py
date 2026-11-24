from __future__ import annotations

from typing import Any, Dict, List, Optional

from app.agents.base import AgentChunk


class AlumniConnectChunk(AgentChunk):
    """Structured output emitted directly by the alumni agent."""

    __slots__ = ("header_message", "response", "data", "is_end", "options")

    HEADER_IN_PROGRESS = "alumni_connect"
    HEADER_MATCHES = "alumni:matches"
    HEADER_REVIEW = "alumni:request-review"
    HEADER_RESUME_SHARE_REVIEW = "alumni:resume-share-review"
    HEADER_COMPLETED = "alumni_connect_completed"

    def __init__(
        self,
        *,
        header_message: str,
        response: str = "",
        data: Optional[Any] = None,
        is_end: bool = True,
        options: Optional[List[str]] = None,
    ) -> None:
        self.header_message = header_message
        self.response = response
        self.data = data if data is not None else {}
        self.is_end = is_end
        self.options = options

    @classmethod
    def matches(cls, alumni: List[Dict[str, Any]]) -> "AlumniConnectChunk":
        return cls(
            header_message=cls.HEADER_MATCHES,
            response=(
                "I found the strongest alumni matches for your current goal. "
                "Choose one and I’ll prepare a personalized connection request for your review."
            ),
            data=alumni,
        )

    @classmethod
    def review(cls, draft: Dict[str, Any]) -> "AlumniConnectChunk":
        return cls(
            header_message=cls.HEADER_REVIEW,
            response=(
                f"Your request to {draft.get('alumni_name', 'the alumnus')} is ready. "
                "Review or edit it on the right; ask me to review again after any change."
            ),
            data=draft,
        )

    @classmethod
    def completion(cls) -> "AlumniConnectChunk":
        return cls(
            header_message=cls.HEADER_COMPLETED,
            response="Your alumni connection request was sent. I cleared the draft and kept the mentorship conversation ready for the next step.",
            data={"status": "completed", "session_cleared": True},
        )

    @classmethod
    def resume_share_review(cls, draft: Dict[str, Any]) -> "AlumniConnectChunk":
        return cls(
            header_message=cls.HEADER_RESUME_SHARE_REVIEW,
            response=(
                f"I selected {draft.get('resume_title', 'your resume')} for {draft.get('alumni_name', 'your mentor')}. "
                "Review the exact version and message before sharing."
            ),
            data=draft,
        )

    @classmethod
    def message(cls, response: str, options: Optional[List[str]] = None) -> "AlumniConnectChunk":
        return cls(
            header_message=cls.HEADER_IN_PROGRESS,
            response=response,
            options=options,
        )
