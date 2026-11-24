from __future__ import annotations

import json
from typing import Any, Dict, List


SYSTEM_PROMPT = """You are a learning-path agent for students after a mock interview.
You receive evidence-backed priority gaps selected from a stored interview report.
Create a concise improvement plan using readable material only.

Rules:
- Never recommend videos, podcasts, audio, or courses that depend on video.
- Never invent URLs, publications, authors, or claims that a resource exists.
- Recommend reading subjects and formats, such as documentation, articles, written
  guides, study notes, cheat sheets, and case studies.
- Keep every priority tied to the supplied gap, score, and evidence.
- Give practical work and a measurable success criterion.
- Return JSON only in the requested shape.
"""


def build_user_turn(interview: Dict[str, Any], priorities: List[Dict[str, Any]]) -> str:
    return (
        "Create a readable learning plan for this completed interview.\n\n"
        f"Interview context:\n{json.dumps(interview, ensure_ascii=False, default=str)}\n\n"
        f"Priorities selected from the report:\n{json.dumps(priorities, ensure_ascii=False)}\n\n"
        "Return exactly:\n"
        "{\n"
        '  "overview": "one short paragraph",\n'
        '  "priorities": [\n'
        "    {\n"
        '      "area": "must match one supplied priority",\n'
        '      "why": "why this matters for the target role",\n'
        '      "recommended_reading": [\n'
        '        {"title": "descriptive study title, not a publication", '
        '"format": "documentation|article|written-guide|study-notes|cheat-sheet|case-study", '
        '"focus": "specific concepts to read", "reading_goal": "what the student should understand"}\n'
        "      ],\n"
        '      "practice_task": "written or coding task",\n'
        '      "success_criteria": "observable outcome",\n'
        '      "follow_up_interview_topic": "focused reassessment topic"\n'
        "    }\n"
        "  ]\n"
        "}"
    )
