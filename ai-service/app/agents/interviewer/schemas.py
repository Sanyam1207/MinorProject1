"""Schemas, enums and the sentinel chunk used by the AI Interviewer Agent.

``InterviewChunk`` is the sentinel the agent yields.  The orchestrator
detects it with ``isinstance(item, InterviewChunk)`` and emits it directly,
bypassing all job-scraping accumulation logic -- the same pattern already
used by ``ResumeChunk`` and ``JobCreationChunk``.
"""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

from app.agents.base import AgentChunk


# ---------------------------------------------------------------------------
# Workflow enums
# ---------------------------------------------------------------------------


class InterviewStage(str, Enum):
    """Phase of a single interview session."""

    CHOOSING = "choosing"                    # showing the two entry options
    AWAITING_JOB_LINK = "awaiting_job_link"  # option 1 picked, waiting for the link
    AWAITING_NAME = "awaiting_name"          # context ready, name is mandatory
    IN_PROGRESS = "in_progress"              # question / answer loop
    ENDED = "ended"                          # report delivered


class InterviewSource(str, Enum):
    """Where the interview draws its material from."""

    JOB = "job"          # option 1 -- a specific job link / job record
    PROFILE = "profile"  # option 2 -- the student's own profile metadata


# ---------------------------------------------------------------------------
# Interview content
# ---------------------------------------------------------------------------


class QAPair(BaseModel):
    """One question the interviewer asked and the answer it received."""

    question: str
    answer: str = ""
    topic: str = "General"
    is_follow_up: bool = False


class JobContext(BaseModel):
    """Job details extracted from the link (or supplied by the DB later)."""

    job_title: str = "Not mentioned"
    company: str = "Not mentioned"
    experience_required: str = "Not mentioned"
    location: str = "Not mentioned"
    employment_type: str = "Not mentioned"
    skills: List[str] = Field(default_factory=list)
    responsibilities: List[str] = Field(default_factory=list)
    qualifications: List[str] = Field(default_factory=list)
    description: str = "Not mentioned"
    source_url: str = ""

    def headline(self) -> str:
        return f"{self.job_title} at {self.company}"


class ProfileContext(BaseModel):
    """The student's own details, pulled from ``req.meta_data``."""

    name: str = ""
    branch: str = ""
    degree: str = ""
    graduation_year: str = ""
    skills: List[str] = Field(default_factory=list)
    projects: List[Dict[str, Any]] = Field(default_factory=list)
    experience: List[Dict[str, Any]] = Field(default_factory=list)

    def headline(self) -> str:
        if self.skills:
            return f"profile-based interview ({', '.join(self.skills[:5])})"
        return "profile-based interview"


# ---------------------------------------------------------------------------
# Report models -- two major factors, each with its own sub-factors
# ---------------------------------------------------------------------------


class SubFactor(BaseModel):
    """One scored sub-factor, with the evidence behind the score."""

    score: float = 0.0                               # 0-10
    strength: List[str] = Field(default_factory=list)
    weakness: List[str] = Field(default_factory=list)


class TechnicalBreakdown(BaseModel):
    """Major factor 1 -- technical ability."""

    score: float = 0.0
    technical_skills: SubFactor = Field(default_factory=SubFactor)
    problem_solving: SubFactor = Field(default_factory=SubFactor)


class CommunicationBreakdown(BaseModel):
    """Major factor 2 -- communication ability."""

    score: float = 0.0
    clarity: SubFactor = Field(default_factory=SubFactor)
    answer_structure: SubFactor = Field(default_factory=SubFactor)
    fillers: SubFactor = Field(default_factory=SubFactor)
    conciseness: SubFactor = Field(default_factory=SubFactor)


class TopicScore(BaseModel):
    """Per-topic performance across the questions that touched that topic."""

    topic: str
    score: float = 0.0
    strength: List[str] = Field(default_factory=list)
    weakness: List[str] = Field(default_factory=list)


class InterviewReport(BaseModel):
    """The full post-interview assessment."""

    candidate_name: str = "Candidate"
    source: InterviewSource = InterviewSource.PROFILE
    role: str = "General"
    duration_minutes: float = 0.0
    questions_asked: int = 0
    ended_reason: str = ""
    generated_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    overall_score: float = 0.0
    technical: TechnicalBreakdown = Field(default_factory=TechnicalBreakdown)
    communication: CommunicationBreakdown = Field(default_factory=CommunicationBreakdown)
    topics: List[TopicScore] = Field(default_factory=list)
    skill_gaps: List[str] = Field(default_factory=list)
    summary: str = ""

    # -- forwarding -------------------------------------------------------

    def _side(self, attr: str) -> Dict[str, Any]:
        """One half of the qualitative split -- ``strength`` or ``weakness``.

        Both halves have an identical shape, so a consumer that can render
        ``positives`` can render ``negatives`` with the same code.
        """
        def pick(sub: SubFactor) -> List[str]:
            return list(getattr(sub, attr))

        return {
            "technical": {
                "technical_skills": pick(self.technical.technical_skills),
                "problem_solving": pick(self.technical.problem_solving),
            },
            "communication": {
                "clarity": pick(self.communication.clarity),
                "answer_structure": pick(self.communication.answer_structure),
                "fillers": pick(self.communication.fillers),
                "conciseness": pick(self.communication.conciseness),
            },
            "topics": [
                {"topic": t.topic, "score": t.score, "points": list(getattr(t, attr))}
                for t in self.topics
                if getattr(t, attr)
            ],
        }

    def to_forward_payload(self) -> Dict[str, Any]:
        """The machine-readable report the system and other agents consume.

        Every number lives in ``scores`` / ``topics`` exactly once, and every
        qualitative line lives in ``positives`` or ``negatives`` exactly once,
        so the two can never disagree::

            report
            +- meta          who / what / how long
            +- overall_score
            +- summary
            +- scores        numbers only
            |  +- technical      score, technical_skills, problem_solving
            |  +- communication  score, clarity, answer_structure,
            |                    fillers, conciseness
            +- topics        [{topic, score}]
            +- positives     what went well, same shape as negatives
            |  +- technical      {technical_skills: [], problem_solving: []}
            |  +- communication  {clarity: [], answer_structure: [],
            |  |                  fillers: [], conciseness: []}
            |  +- topics         [{topic, score, points: []}]
            +- negatives     what did not, identical shape
            +- skill_gaps    what to go and learn
        """
        return {
            "report": {
                "meta": {
                    "candidate_name": self.candidate_name,
                    "source": self.source.value,
                    "role": self.role,
                    "duration_minutes": self.duration_minutes,
                    "questions_asked": self.questions_asked,
                    "ended_reason": self.ended_reason,
                    "generated_at": self.generated_at,
                },
                "overall_score": self.overall_score,
                "summary": self.summary,
                "scores": {
                    "technical": {
                        "score": self.technical.score,
                        "technical_skills": self.technical.technical_skills.score,
                        "problem_solving": self.technical.problem_solving.score,
                    },
                    "communication": {
                        "score": self.communication.score,
                        "clarity": self.communication.clarity.score,
                        "answer_structure": self.communication.answer_structure.score,
                        "fillers": self.communication.fillers.score,
                        "conciseness": self.communication.conciseness.score,
                    },
                },
                "topics": [{"topic": t.topic, "score": t.score} for t in self.topics],
                "positives": self._side("strength"),
                "negatives": self._side("weakness"),
                "skill_gaps": self.skill_gaps,
            }
        }


# ---------------------------------------------------------------------------
# Sentinel yielded by the agent -- detected by the orchestrator
# ---------------------------------------------------------------------------


class InterviewChunk(AgentChunk):
    """A single output unit from the AI Interviewer Agent."""

    __slots__ = ("header_message", "response", "data", "is_end", "session_id", "options")

    # Frontend-facing header constants
    HEADER_OPTIONS = "button:options"         # the two entry choices
    HEADER_SELECT_JOB = "select:job:db"       # option 1 picked -- job link / DB pick
    HEADER_INTERVIEW = "text:mode:interview"  # question / answer turns
    HEADER_END = "interview:end"              # final turn, carries the report

    def __init__(
        self,
        *,
        header_message: str,
        response: str = "",
        data: Optional[Dict[str, Any]] = None,
        is_end: bool = False,
        session_id: str = "",
        options: Optional[List[str]] = None,
    ) -> None:
        self.header_message = header_message
        self.response = response
        self.data = data or {}
        self.is_end = is_end
        self.session_id = session_id
        self.options = options

    # -- convenience constructors ----------------------------------------

    @classmethod
    def options_chunk(cls, *, response: str, session_id: str = "") -> "InterviewChunk":
        """The two entry choices, rendered as buttons on the left of the screen."""
        return cls(
            header_message=cls.HEADER_OPTIONS,
            response=response,
            options=[
                "I want to give a mock interview for this job",
                "I want to give an interview based on my profile",
            ],
            data={
                "type": "options",
                "options": [
                    {
                        "value": "job",
                        "label": "I want to give a mock interview for this job ____",
                        "placeholder": "Paste the job link here",
                        "requires_input": True,
                    },
                    {
                        "value": "profile",
                        "label": "I want to give an interview based on my profile",
                        "requires_input": False,
                    },
                ],
            },
            is_end=True,
            session_id=session_id,
        )

    @classmethod
    def select_job_chunk(cls, *, response: str, session_id: str = "") -> "InterviewChunk":
        """Option 1 picked -- ask for the job link (DB-backed picker lands later)."""
        return cls(
            header_message=cls.HEADER_SELECT_JOB,
            response=response,
            data={"type": "select_job", "source": "db", "awaiting": "job_link"},
            is_end=True,
            session_id=session_id,
        )

    @classmethod
    def question_chunk(
        cls,
        *,
        response: str,
        question_number: int,
        topic: str = "General",
        is_follow_up: bool = False,
        seconds_remaining: int = 0,
        session_id: str = "",
    ) -> "InterviewChunk":
        """One interview question."""
        return cls(
            header_message=cls.HEADER_INTERVIEW,
            response=response,
            data={
                "type": "interview_question",
                "question_number": question_number,
                "topic": topic,
                "is_follow_up": is_follow_up,
                "seconds_remaining": seconds_remaining,
            },
            is_end=True,
            session_id=session_id,
        )

    @classmethod
    def end_chunk(
        cls,
        *,
        response: str,
        report: InterviewReport,
        reason: str,
        session_id: str = "",
    ) -> "InterviewChunk":
        """Final turn -- carries the human summary and the forwardable report.

        ``data.report`` is the whole machine-readable assessment; nothing is
        repeated alongside it, so there is exactly one copy of every score and
        every finding on the wire.
        """
        payload: Dict[str, Any] = {"type": "interview_report", "reason": reason}
        payload.update(report.to_forward_payload())
        return cls(
            header_message=cls.HEADER_END,
            response=response,
            data=payload,
            is_end=True,
            session_id=session_id,
        )

    @classmethod
    def error_chunk(cls, *, response: str, session_id: str = "") -> "InterviewChunk":
        """Non-fatal error / unusable input."""
        return cls(
            header_message=cls.HEADER_INTERVIEW,
            response=response,
            data={"type": "error"},
            is_end=True,
            session_id=session_id,
        )
