from __future__ import annotations

from typing import Any, Dict, List, Optional

from app.agents.base import AgentChunk


class LearningRecommendationChunk(AgentChunk):
    __slots__ = ("header_message", "response", "data", "is_end", "options")

    HEADER = "learning:recommendations"
    HEADER_SELECT_INTERVIEW = "select:interview:db"
    HEADER_ERROR = "learning:recommendations-error"

    def __init__(
        self,
        *,
        header_message: str = HEADER,
        response: str = "",
        data: Optional[Dict[str, Any]] = None,
        is_end: bool = True,
        options: Optional[List[str]] = None,
        error: bool = False,
    ) -> None:
        self.header_message = self.HEADER_ERROR if error else header_message
        self.response = response
        self.data = data or {}
        self.is_end = is_end
        self.options = options

    @classmethod
    def select_interview_chunk(
        cls,
        *,
        response: str = "Please select one of your past mock interviews from the list on the right to generate your personalized learning plan.",
        past_interviews: Optional[List[Dict[str, Any]]] = None,
    ) -> "LearningRecommendationChunk":
        return cls(
            header_message=cls.HEADER_SELECT_INTERVIEW,
            response=response,
            data={
                "type": "select_interview",
                "source": "db",
                "interviews": past_interviews or [],
            },
            is_end=True,
        )

    @classmethod
    def error(
        cls, message: str, options: Optional[List[str]] = None
    ) -> "LearningRecommendationChunk":
        return cls(
            header_message=cls.HEADER_ERROR,
            response=message,
            data={"type": "learning_recommendation_error", "message": message},
            options=options,
            error=True,
        )
