"""Chunk types for the Gap Analysis Agent.

``GapAnalysisChunk`` is the sentinel object that the agent yields.
The orchestrator detects it with ``isinstance(item, AgentChunk)`` and
emits it directly — the same pattern as ``JobCreationChunk``.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from app.agents.base import AgentChunk


class GapAnalysisChunk(AgentChunk):
    """A single output unit from the Gap Analysis Agent.

    Attributes
    ----------
    header_message : str
        One of the ``HEADER_*`` constants.
    response : str
        Human-readable Markdown for the chat panel.
    data : dict
        Structured payload for the frontend workspace.
    is_end : bool
        True only on the very last chunk of a request.
    confidence_score : float | None
        Optional overall confidence (0-1).
    options : list[str] | None
        Optional clickable choice buttons rendered in chat.
    """

    __slots__ = (
        "header_message", "response", "data", "is_end",
        "confidence_score", "options",
    )

    # Frontend-facing header constants
    HEADER_ANALYSIS = "mode:gapAnalysis:analysis"
    HEADER_SUGGESTIONS = "mode:gapAnalysis:suggestions"
    HEADER_ERROR = "mode:gapAnalysis:error"
    HEADER_IN_PROGRESS = HEADER_ANALYSIS  # alias for CONTENT_HEADERS

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

    # ── Convenience constructors ─────────────────────────────────────────

    @classmethod
    def analysis_chunk(
        cls,
        *,
        response: str,
        gaps: Optional[List[Dict[str, Any]]] = None,
        suggestions: Optional[List[Dict[str, Any]]] = None,
        options: Optional[List[str]] = None,
        confidence_score: Optional[float] = None,
        is_end: bool = True,
    ) -> "GapAnalysisChunk":
        """Main conversational / analysis response."""
        return cls(
            header_message=cls.HEADER_ANALYSIS,
            response=response,
            data={
                "type": "gap_analysis",
                "gaps": gaps or [],
                "suggestions": suggestions or [],
            },
            is_end=is_end,
            confidence_score=confidence_score,
            options=options,
        )

    @classmethod
    def suggestions_chunk(
        cls,
        *,
        response: str,
        suggestions: List[Dict[str, Any]],
        confidence_score: Optional[float] = None,
        options: Optional[List[str]] = None,
        is_end: bool = True,
    ) -> "GapAnalysisChunk":
        """Elective recommendation response with confidence scores."""
        return cls(
            header_message=cls.HEADER_SUGGESTIONS,
            response=response,
            data={
                "type": "gap_suggestions",
                "suggestions": suggestions,
            },
            is_end=is_end,
            confidence_score=confidence_score,
            options=options,
        )

    @classmethod
    def error_chunk(
        cls,
        *,
        response: str,
    ) -> "GapAnalysisChunk":
        """Non-fatal error / authorisation failure."""
        return cls(
            header_message=cls.HEADER_ERROR,
            response=response,
            data={"type": "error"},
            is_end=True,
        )
