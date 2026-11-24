"""Pydantic models and dataclasses used throughout the Resume Generator Agent.

``ResumeChunk`` is the sentinel object that the agent yields.
The orchestrator detects it with ``isinstance(item, ResumeChunk)`` and emits
it directly, bypassing all job-scraping accumulation logic.
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

from app.agents.base import AgentChunk


# ---------------------------------------------------------------------------
# Status enums
# ---------------------------------------------------------------------------


class SectionStatus(str, Enum):
    """Tracks what the user has done with an optional resume section."""
    UNKNOWN = "unknown"    # not yet asked
    PROVIDED = "provided"  # user gave information
    SKIPPED = "skipped"    # user explicitly opted out


class SessionStatus(str, Enum):
    """High-level phase the resume session is in."""
    COLLECTING = "collecting"       # gathering information from user
    GENERATING = "generating"       # LaTeX being / just been streamed
    EDITING = "editing"             # post-generation edits


# ---------------------------------------------------------------------------
# Structured resume data
# ---------------------------------------------------------------------------


class PersonalInfo(BaseModel):
    name: str = ""
    email: str = ""
    phone: str = ""
    location: str = ""
    linkedin: str = ""
    github: str = ""
    portfolio: str = ""


class EducationEntry(BaseModel):
    institution: str = ""
    degree: str = ""
    branch: str = ""
    cgpa: str = ""
    graduation_year: str = ""
    tenth_percentage: str = ""
    twelfth_percentage: str = ""


class ExperienceEntry(BaseModel):
    company: str = ""
    role: str = ""
    duration: str = ""
    description: List[str] = Field(default_factory=list)


class ProjectEntry(BaseModel):
    name: str = ""
    tech_stack: str = ""
    description: List[str] = Field(default_factory=list)
    link: str = ""


class CertificationEntry(BaseModel):
    name: str = ""
    issuer: str = ""
    year: str = ""


class AchievementEntry(BaseModel):
    title: str = ""
    description: str = ""


class PositionEntry(BaseModel):
    role: str = ""
    organization: str = ""
    duration: str = ""
    description: str = ""


class LanguageEntry(BaseModel):
    language: str = ""
    proficiency: str = ""


class ResumeData(BaseModel):
    """The full structured content of the resume being built."""
    personal: PersonalInfo = Field(default_factory=PersonalInfo)
    education: List[EducationEntry] = Field(default_factory=list)
    experience: List[ExperienceEntry] = Field(default_factory=list)
    projects: List[ProjectEntry] = Field(default_factory=list)
    skills: List[str] = Field(default_factory=list)
    achievements: List[AchievementEntry] = Field(default_factory=list)
    certifications: List[CertificationEntry] = Field(default_factory=list)
    positions: List[PositionEntry] = Field(default_factory=list)
    languages: List[LanguageEntry] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Sentinel yielded by the agent, detected by the orchestrator
# ---------------------------------------------------------------------------


RESUME_HEADER_MESSAGE = "resume-generator"


class ResumeChunk(AgentChunk):
    """A single output unit from the Resume Generator Agent.

    The orchestrator emits any ``AgentChunk`` directly, without any
    job-scraping post-processing.

    Attributes
    ----------
    type:       "text" for conversational replies, "latex" for resume code chunks.
    response:   Human-readable message (populated for type="text"; "" for latex).
    data:       Structured payload for the frontend's LaTeX/render panel.
    is_end:     True only on the very last chunk of a request.
    session_id: The session this chunk belongs to.
    """

    __slots__ = ("type", "header_message", "response", "data", "is_end", "session_id")

    def __init__(
        self,
        *,
        type: str,
        response: str = "",
        data: Optional[Dict[str, Any]] = None,
        is_end: bool = False,
        session_id: str = "",
    ) -> None:
        self.type = type
        # Every resume chunk goes out under the one header the UI expects.
        self.header_message = RESUME_HEADER_MESSAGE
        self.response = response
        self.data = data or {}
        self.is_end = is_end
        self.session_id = session_id

    @classmethod
    def error(cls, message: str, *, session_id: str = "") -> "ResumeChunk":
        """Terminal chunk for a failure the user should see."""
        return cls(
            type="text",
            response=message,
            data={"type": "text"},
            is_end=True,
            session_id=session_id,
        )

    @classmethod
    def text(cls, message: str, *, session_id: str = "", is_end: bool = False) -> "ResumeChunk":
        """Convenience constructor for a conversational text response."""
        return cls(
            type="text",
            response=message,
            data={"type": "text"},
            is_end=is_end,
            session_id=session_id,
        )

    @classmethod
    def latex(cls, content: str, *, session_id: str = "", is_end: bool = False) -> "ResumeChunk":
        """Convenience constructor for a LaTeX streaming chunk."""
        data: Dict[str, Any] = {"type": "latex", "content": content}
        if is_end:
            data["status"] = "complete"
        return cls(
            type="latex",
            response="",
            data=data,
            is_end=is_end,
            session_id=session_id,
        )

    @classmethod
    def analysis(cls, result: Dict[str, Any], *, session_id: str = "") -> "ResumeChunk":
        return cls(
            type="analysis",
            response=str(result.get("summary") or "Your resume analysis is ready."),
            data=result,
            is_end=True,
            session_id=session_id,
        )
