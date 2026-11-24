"""Post-interview assessment for the AI Interviewer Agent.

Gemini scores the transcript; everything it returns is coerced and clamped
here before it becomes an ``InterviewReport``. If the scoring call fails, a
neutral fallback report is produced instead -- an interview always ends with
a report, never with an error.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from app.agents.interviewer.llm import call_gemini_json
from app.agents.interviewer.prompt import SYSTEM_PROMPT_REPORT, build_report_user_turn
from app.agents.interviewer.schemas import (
    CommunicationBreakdown,
    InterviewReport,
    InterviewSource,
    SubFactor,
    TechnicalBreakdown,
    TopicScore,
)

log = logging.getLogger("interviewer.report")


# ---------------------------------------------------------------------------
# Coercion helpers -- the model's output is never trusted verbatim
# ---------------------------------------------------------------------------


def _score(value: Any, default: float = 5.0) -> float:
    try:
        return round(max(0.0, min(10.0, float(value))), 1)
    except (TypeError, ValueError):
        return default


def _lines(value: Any, limit: int = 4) -> List[str]:
    if not isinstance(value, list):
        return []
    out = [str(item).strip() for item in value if str(item).strip()]
    return out[:limit]


def _subfactor(data: Any) -> SubFactor:
    if not isinstance(data, dict):
        return SubFactor(score=5.0)
    return SubFactor(
        score=_score(data.get("score")),
        strength=_lines(data.get("strength")),
        weakness=_lines(data.get("weakness")),
    )


def _mean(values: List[float]) -> float:
    return round(sum(values) / len(values), 1) if values else 5.0


def _technical(data: Any) -> TechnicalBreakdown:
    block = data if isinstance(data, dict) else {}
    skills = _subfactor(block.get("technical_skills"))
    solving = _subfactor(block.get("problem_solving"))
    score = block.get("score")
    return TechnicalBreakdown(
        score=_score(score, default=_mean([skills.score, solving.score])),
        technical_skills=skills,
        problem_solving=solving,
    )


def _communication(data: Any) -> CommunicationBreakdown:
    block = data if isinstance(data, dict) else {}
    clarity = _subfactor(block.get("clarity"))
    structure = _subfactor(block.get("answer_structure"))
    fillers = _subfactor(block.get("fillers"))
    concise = _subfactor(block.get("conciseness"))
    score = block.get("score")
    return CommunicationBreakdown(
        score=_score(
            score,
            default=_mean([clarity.score, structure.score, fillers.score, concise.score]),
        ),
        clarity=clarity,
        answer_structure=structure,
        fillers=fillers,
        conciseness=concise,
    )


def _topics(data: Any) -> List[TopicScore]:
    if not isinstance(data, list):
        return []
    topics: List[TopicScore] = []
    for item in data[:12]:
        if not isinstance(item, dict):
            continue
        label = str(item.get("topic") or "").strip()
        if not label:
            continue
        topics.append(TopicScore(
            topic=label,
            score=_score(item.get("score")),
            strength=_lines(item.get("strength")),
            weakness=_lines(item.get("weakness")),
        ))
    return topics


# ---------------------------------------------------------------------------
# Report building
# ---------------------------------------------------------------------------


def _fallback_report(state, reason: str) -> InterviewReport:
    """Neutral report used when the scoring call fails or nothing was answered."""
    answered = len(state.answered_pairs())
    if answered == 0:
        summary = (
            "This interview ended before any question was answered, so there is "
            "nothing to score yet. Start a fresh interview whenever you're ready."
        )
        note = "No answers were given, so there was no evidence to score."
    else:
        summary = (
            f"You answered {answered} question(s). The detailed scoring could not be "
            "generated this time, so these are neutral placeholder scores -- run the "
            "interview again to get a real assessment."
        )
        note = "Scoring was unavailable for this interview."

    neutral = SubFactor(score=5.0, weakness=[note])
    return InterviewReport(
        candidate_name=state.candidate_name or "Candidate",
        source=state.source or InterviewSource.PROFILE,
        role=state.role_label(),
        duration_minutes=state.duration_minutes(),
        questions_asked=len(state.qa),
        ended_reason=reason,
        overall_score=5.0,
        technical=TechnicalBreakdown(
            score=5.0,
            technical_skills=neutral.model_copy(),
            problem_solving=neutral.model_copy(),
        ),
        communication=CommunicationBreakdown(
            score=5.0,
            clarity=neutral.model_copy(),
            answer_structure=neutral.model_copy(),
            fillers=neutral.model_copy(),
            conciseness=neutral.model_copy(),
        ),
        topics=[],
        skill_gaps=[],
        summary=summary,
    )


async def generate_report(state, reason: str) -> InterviewReport:
    """Score the finished interview held in *state*."""
    if not state.answered_pairs():
        return _fallback_report(state, reason)

    data = await call_gemini_json(
        SYSTEM_PROMPT_REPORT,
        build_report_user_turn(
            candidate_name=state.candidate_name or "Candidate",
            source=(state.source or InterviewSource.PROFILE).value,
            role=state.role_label(),
            job=state.job.model_dump() if state.job else None,
            profile=state.profile.model_dump() if state.profile else None,
            transcript=state.transcript(),
            duration_minutes=state.duration_minutes(),
            questions_asked=len(state.qa),
            end_reason=reason,
        ),
        temperature=0.3,
        max_output_tokens=2048,
        timeout=30.0,
    )

    if not data:
        log.warning("interview report scoring failed -- using the neutral fallback")
        return _fallback_report(state, reason)

    technical = _technical(data.get("technical"))
    communication = _communication(data.get("communication"))
    overall = _score(
        data.get("overall_score"),
        default=_mean([technical.score, communication.score]),
    )

    return InterviewReport(
        candidate_name=state.candidate_name or "Candidate",
        source=state.source or InterviewSource.PROFILE,
        role=state.role_label(),
        duration_minutes=state.duration_minutes(),
        questions_asked=len(state.qa),
        ended_reason=reason,
        overall_score=overall,
        technical=technical,
        communication=communication,
        topics=_topics(data.get("topics")),
        skill_gaps=_lines(data.get("skill_gaps"), limit=8),
        summary=str(data.get("summary") or "").strip() or "Interview complete.",
    )


# ---------------------------------------------------------------------------
# Human-readable rendering (the `response` field on the final chunk)
# ---------------------------------------------------------------------------


def _bullets(items: List[str], prefix: str = "-") -> List[str]:
    return [f"{prefix} {item}" for item in items]


def format_report_markdown(report: InterviewReport) -> str:
    """Render the report for the chat panel."""
    lines: List[str] = [
        f"## Interview Report -- {report.candidate_name}",
        "",
        f"**Role:** {report.role}  ",
        f"**Length:** {report.duration_minutes} min, {report.questions_asked} question(s)  ",
        f"**Overall:** {report.overall_score}/10",
        "",
        "### Technical",
        f"| Factor | Score |",
        f"|---|---|",
        f"| Technical skills | {report.technical.technical_skills.score}/10 |",
        f"| Problem solving | {report.technical.problem_solving.score}/10 |",
        f"| **Technical overall** | **{report.technical.score}/10** |",
        "",
        "### Communication",
        f"| Factor | Score |",
        f"|---|---|",
        f"| Clarity | {report.communication.clarity.score}/10 |",
        f"| Answer structure | {report.communication.answer_structure.score}/10 |",
        f"| Fillers | {report.communication.fillers.score}/10 |",
        f"| Conciseness | {report.communication.conciseness.score}/10 |",
        f"| **Communication overall** | **{report.communication.score}/10** |",
    ]

    if report.topics:
        lines += ["", "### Topics covered"]
        for topic in report.topics:
            lines.append(f"**{topic.topic}** -- {topic.score}/10")
            lines += _bullets(topic.strength)
            lines += _bullets(topic.weakness)

    if report.skill_gaps:
        lines += ["", "### What to work on"]
        lines += _bullets(report.skill_gaps)

    if report.summary:
        lines += ["", "### Summary", report.summary]

    return "\n".join(lines)
