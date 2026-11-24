from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Dict, List, Optional

from app.agents.interviewer.llm import call_gemini_json
from app.agents.learning_recommendation.prompt import SYSTEM_PROMPT, build_user_turn
from app.agents.learning_recommendation.schemas import LearningRecommendationChunk
from app.agents.routing import RoutingRules
from app.schemas import QueryRequest
from app.agents.roles import resolve_role


_FACTORS = (
    ("Technical skills", "technical", ["technicalSkills", "technical_skills"]),
    ("Problem solving", "technical", ["problemSolving", "problem_solving"]),
    ("Clarity", "communication", ["clarity"]),
    ("Answer structure", "communication", ["answerStructure", "answer_structure"]),
    ("Reducing fillers", "communication", ["fillers"]),
    ("Conciseness", "communication", ["conciseness"]),
)
_ALLOWED_FORMATS = {
    "documentation", "article", "written-guide", "study-notes", "cheat-sheet", "case-study",
}


def _text(value: Any, limit: int = 1000) -> str:
    return str(value or "").strip()[:limit]


def _score(value: Any) -> Optional[float]:
    try:
        return round(max(0.0, min(10.0, float(value))), 1)
    except (TypeError, ValueError):
        return None


def _lines(value: Any, limit: int = 6) -> List[str]:
    if not isinstance(value, list):
        return []
    return [_text(item, 500) for item in value if _text(item, 500)][:limit]


def _key(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()


def _factor_evidence(interview: Dict[str, Any], group: str, fields: List[str]) -> List[str]:
    negatives = interview.get("negatives") or {}
    group_data = negatives.get(group) or {}
    for f in fields:
        evidence = _lines(group_data.get(f))
        if evidence:
            return evidence
    return []


def _select_priorities(interview: Dict[str, Any]) -> List[Dict[str, Any]]:
    # Unwrap rawReport if wrapped inside a DB record
    if "rawReport" in interview and isinstance(interview["rawReport"], dict):
        raw = interview["rawReport"]
        # Merge top-level skillGaps or scores if raw has them
        interview = {**interview, **raw}
    elif "raw_report" in interview and isinstance(interview["raw_report"], dict):
        raw = interview["raw_report"]
        interview = {**interview, **raw}

    selected: List[Dict[str, Any]] = []
    seen: set[str] = set()

    def add(area: str, current_score: Optional[float], evidence: List[str], source: str) -> None:
        normalized = _key(area)
        if not normalized or normalized in seen or len(selected) >= 3:
            return
        seen.add(normalized)
        selected.append({
            "area": _text(area, 200),
            "current_score": current_score,
            "evidence": evidence,
            "source": source,
        })

    # 1. Explicit skill gaps
    gaps = interview.get("skill_gaps") or interview.get("skillGaps") or []
    for gap in _lines(gaps, limit=8):
        add(gap, None, [], "explicit_skill_gap")

    # 2. Factor and topic scores
    score_candidates: List[tuple[float, str, List[str], str]] = []
    scores = interview.get("scores") or {}
    for label, group, fields in _FACTORS:
        group_data = scores.get(group) or {}
        val = None
        for f in fields:
            val = _score(group_data.get(f))
            if val is not None:
                break
        if val is not None:
            score_candidates.append((val, label, _factor_evidence(interview, group, fields), "factor_score"))

    for topic in interview.get("topics") or []:
        val = _score(topic.get("score"))
        label = _text(topic.get("topic"), 200)
        if val is not None and label:
            score_candidates.append((val, label, [], "topic_score"))

    for value, label, evidence, source in sorted(score_candidates, key=lambda item: item[0]):
        add(label, value, evidence, source)

    # If still empty, add default communication & technical areas
    if not selected:
        add("Technical Depth & Problem Solving", 6.0, [], "fallback")
        add("Communication & Answer Structure", 6.5, [], "fallback")

    return selected


def _fallback_plan(priorities: List[Dict[str, Any]], role: str) -> Dict[str, Any]:
    items = []
    for priority in priorities:
        area = priority["area"]
        items.append({
            **priority,
            "why": f"Improving {area.lower()} will strengthen performance for {role} interviews.",
            "recommended_reading": [
                {
                    "title": f"{area}: concepts and worked examples",
                    "format": "written-guide",
                    "focus": f"Core concepts, common mistakes, and interview-ready explanations for {area.lower()}.",
                    "reading_goal": f"Explain {area.lower()} clearly and apply it to one example without assistance.",
                },
                {
                    "title": f"{area} revision notes",
                    "format": "cheat-sheet",
                    "focus": "Definitions, decision rules, examples, and frequent interview mistakes.",
                    "reading_goal": "Produce a one-page personal revision sheet from memory.",
                },
            ],
            "practice_task": f"Write one interview answer about {area.lower()}, then improve it using the reading notes.",
            "success_criteria": "Give a structured answer with a correct explanation and a concrete example.",
            "follow_up_interview_topic": area,
        })
    return {
        "overview": "Work through these priorities in order, then take a focused mock interview to measure improvement.",
        "priorities": items,
    }


def _merge_generated_plan(
    priorities: List[Dict[str, Any]], generated: Optional[Dict[str, Any]], role: str
) -> Dict[str, Any]:
    fallback = _fallback_plan(priorities, role)
    if not isinstance(generated, dict) or not isinstance(generated.get("priorities"), list):
        return fallback

    generated_by_area = {
        _key(item.get("area", "")): item
        for item in generated["priorities"]
        if isinstance(item, dict)
    }
    merged = []
    for index, priority in enumerate(priorities):
        base = fallback["priorities"][index]
        candidate = generated_by_area.get(_key(priority["area"]), {})
        readings = []
        for reading in candidate.get("recommended_reading", [])[:3] if isinstance(candidate, dict) else []:
            if not isinstance(reading, dict):
                continue
            resource_format = _text(reading.get("format"), 40)
            if resource_format not in _ALLOWED_FORMATS:
                continue
            readings.append({
                "title": _text(reading.get("title"), 200),
                "format": resource_format,
                "focus": _text(reading.get("focus"), 1000),
                "reading_goal": _text(reading.get("reading_goal"), 1000),
            })
        merged.append({
            **priority,
            "why": _text(candidate.get("why"), 1000) or base["why"],
            "recommended_reading": readings or base["recommended_reading"],
            "practice_task": _text(candidate.get("practice_task"), 1000) or base["practice_task"],
            "success_criteria": _text(candidate.get("success_criteria"), 1000) or base["success_criteria"],
            "follow_up_interview_topic": _text(candidate.get("follow_up_interview_topic"), 200) or priority["area"],
        })
    return {
        "overview": _text(generated.get("overview"), 1500) or fallback["overview"],
        "priorities": merged,
    }


def _markdown(plan: Dict[str, Any], role: str, overall_score: Optional[float]) -> str:
    lines = ["## Your Interview Improvement Plan", "", f"**Based on:** {role}"]
    if overall_score is not None:
        lines.append(f"**Interview score:** {overall_score}/10")
    lines += ["", plan["overview"]]
    for index, item in enumerate(plan["priorities"], start=1):
        score_label = f" — {item['current_score']}/10" if item.get("current_score") is not None else ""
        lines += ["", f"### {index}. {item['area']}{score_label}", item["why"]]
        if item.get("evidence"):
            lines += ["", "**Evidence from the interview:**"] + [f"- {line}" for line in item["evidence"]]
        lines += ["", "**Recommended reading:**"]
        for reading in item["recommended_reading"]:
            lines.append(f"- **{reading['title']}** ({reading['format']}): {reading['focus']} Goal: {reading['reading_goal']}")
        lines += [
            "",
            f"**Practice:** {item['practice_task']}",
            f"**Ready when:** {item['success_criteria']}",
            f"**Follow-up interview:** {item['follow_up_interview_topic']}",
        ]
    return "\n".join(lines)


class LearningRecommendationAgent:
    name = "learning-recommendation"
    SWITCH_MESSAGE = "I’ll build a readable improvement plan from your past interview performance."
    emits_own_chunks = True
    content_header = LearningRecommendationChunk.HEADER

    ROUTING_RULES = RoutingRules(
        strong=(
            r"\b(?:recommend(?:ation)?s?|suggest|plan|resources?)\b[^.?!]{0,60}\b(?:lack|lacks|gap|gaps|weak|weakness|improve|interview|mock|score|performance|latest)\b",
            r"\b(?:recommend|suggest)\b[^.?!]{0,30}\bresources?\b[^.?!]{0,40}\b(?:mock|interview|latest)\b",
            r"\bwhat\s+should\s+i\s+(?:read|study|learn|improve)\b",
            r"\bwhere\s+i\s+lack\b",
            r"\bimprovement\s+plan\b[^.?!]{0,40}\binterview\b",
        ),
        weak=(r"\brecommendations?\b", r"\blearning\s+plan\b", r"\bskill\s+gaps?\b"),
        veto=(r"\b(?:alumni|mentor|mentorship|video|videos)\b",),
    )

    @staticmethod
    def error_chunk(message: str, session_id: str = "") -> LearningRecommendationChunk:
        return LearningRecommendationChunk.error(message)

    async def run(self, req: QueryRequest) -> AsyncIterator[Any]:
        if resolve_role(req) != "student":
            yield LearningRecommendationChunk.error("Interview recommendations are currently available only to students.")
            return

        meta = req.meta_data or {}
        interview = meta.get("selected_interview") or meta.get("latest_interview")

        # If no interview was selected/provided, prompt the user to select from DB interviews
        if not isinstance(interview, dict):
            past_interviews = meta.get("past_interviews")
            if isinstance(past_interviews, list) and len(past_interviews) == 0:
                yield LearningRecommendationChunk.error(
                    "You don't have any completed mock interviews in your profile yet. Please complete a mock interview first, and then I'll generate a personalized learning plan based on your recorded performance!",
                    options=["Take a Mock Interview"],
                )
                return

            yield LearningRecommendationChunk.select_interview_chunk(
                response="Please select one of your completed mock interviews from the list on the right to build your personalized learning & improvement roadmap.",
                past_interviews=past_interviews if isinstance(past_interviews, list) else [],
            )
            return

        priorities = _select_priorities(interview)
        if not priorities:
            yield LearningRecommendationChunk.error(
                "The selected interview report does not contain enough scored gaps to build a recommendation plan.",
                options=["Choose Another Interview", "Take a Mock Interview"],
            )
            return

        role = _text(interview.get("role") or interview.get("roleTitle") or (interview.get("meta") or {}).get("role"), 500) or "General interview"
        generated = await call_gemini_json(
            SYSTEM_PROMPT,
            build_user_turn(interview, priorities),
            temperature=0.3,
            max_output_tokens=1800,
            timeout=25.0,
        )
        plan = _merge_generated_plan(priorities, generated, role)
        overall_score = _score(interview.get("overallScore") or interview.get("overall_score"))
        data = {
            "type": "learning_recommendations",
            "interview_id": _text(interview.get("_id") or interview.get("id") or interview.get("interview_id"), 100),
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "role": role,
            "overall_score": overall_score,
            "content_policy": {"readable_only": True, "videos_excluded": True, "urls_generated": False},
            **plan,
        }
        yield LearningRecommendationChunk(
            header_message=LearningRecommendationChunk.HEADER,
            response=_markdown(data, role, overall_score),
            data=data,
            options=["Take a Follow-up Mock Interview", "Select Another Interview"],
        )
