"""Structured ATS scoring and job-gap analysis for saved/generated resumes."""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

from app.llm import gemini
from app.agents.resume_generator.tailoring import build_tailoring_context, normalize_target_job

log = logging.getLogger("resume_agent.analysis")

_SYSTEM_PROMPT = """
You are a strict resume evaluator. Compare the actual resume, authoritative candidate profile,
and selected job. Never claim the candidate has a skill unless it exists in the resume or profile.
Distinguish two gap types:
- resume_gaps: evidence exists in the profile but is absent or weak in the resume.
- profile_gaps: the job requires something unsupported by both profile and resume.

Return one JSON object only with this shape:
{
  "analysis_type": "score" or "gap",
  "overall_score": integer 0-100,
  "subscores": {"ats_structure": integer, "keyword_coverage": integer, "experience_relevance": integer, "project_relevance": integer},
  "matched_requirements": [{"requirement": string, "evidence": string}],
  "resume_gaps": [{"requirement": string, "issue": string, "recommendation": string}],
  "profile_gaps": [{"requirement": string, "issue": string, "recommendation": string}],
  "strengths": [string],
  "recommendations": [string],
  "summary": string
}
Scores must be evidence-based. Do not reward unsupported keyword stuffing.
""".strip()


def _score(value: Any) -> int:
    try:
        return max(0, min(100, int(round(float(value)))))
    except (TypeError, ValueError):
        return 0


def _items(value: Any) -> List[Any]:
    return value if isinstance(value, list) else []


def _normalize_result(result: Dict[str, Any], analysis_type: str, target: Optional[Dict[str, Any]], resume_record: Dict[str, Any]) -> Dict[str, Any]:
    subscores = result.get("subscores") if isinstance(result.get("subscores"), dict) else {}
    return {
        "type": "analysis",
        "analysis_type": analysis_type,
        "overall_score": _score(result.get("overall_score")),
        "subscores": {key: _score(subscores.get(key)) for key in (
            "ats_structure", "keyword_coverage", "experience_relevance", "project_relevance"
        )},
        "matched_requirements": _items(result.get("matched_requirements")),
        "resume_gaps": _items(result.get("resume_gaps")),
        "profile_gaps": _items(result.get("profile_gaps")),
        "strengths": [str(item) for item in _items(result.get("strengths"))],
        "recommendations": [str(item) for item in _items(result.get("recommendations"))],
        "summary": str(result.get("summary") or "Resume analysis completed."),
        "target_job": target,
        "resume": {
            "title": str(resume_record.get("title") or "Current generated resume"),
            "version": resume_record.get("version"),
        },
    }


def _fallback_analysis(resume_source: str, resume_data: Dict[str, Any], target: Optional[Dict[str, Any]], analysis_type: str, resume_record: Dict[str, Any]) -> Dict[str, Any]:
    context = build_tailoring_context(resume_data, target) if target else None
    required = (context or {}).get("target_job", {}).get("required_skills", [])
    profile_matches = (context or {}).get("exact_skill_matches", [])
    unsupported = (context or {}).get("unsupported_job_skills", [])
    source_lower = resume_source.lower()
    matched = [skill for skill in profile_matches if skill.lower() in source_lower]
    omitted = [skill for skill in profile_matches if skill.lower() not in source_lower]
    coverage = round(100 * len(matched) / len(required)) if required else 70
    structure_checks = ["\\section" in resume_source, "\\item" in resume_source, "education" in source_lower, "skill" in source_lower]
    structure = round(100 * sum(structure_checks) / len(structure_checks))
    evidence_sections = bool(resume_data.get("experience")) + bool(resume_data.get("projects"))
    relevance = 50 + (25 * evidence_sections)
    result = {
        "overall_score": round((structure + coverage + relevance + relevance) / 4),
        "subscores": {
            "ats_structure": structure,
            "keyword_coverage": coverage,
            "experience_relevance": relevance if resume_data.get("experience") else 40,
            "project_relevance": relevance if resume_data.get("projects") else 40,
        },
        "matched_requirements": [{"requirement": skill, "evidence": "Present in the candidate evidence and resume"} for skill in matched],
        "resume_gaps": [{"requirement": skill, "issue": "Present in the profile but not clearly shown in this resume", "recommendation": "Add truthful evidence from an existing project or experience"} for skill in omitted],
        "profile_gaps": [{"requirement": skill, "issue": "No supporting evidence found in the profile or resume", "recommendation": "Develop and demonstrate this skill before adding it"} for skill in unsupported],
        "strengths": [f"Supported match: {skill}" for skill in matched],
        "recommendations": ["Use measurable outcomes in project and experience bullets."],
        "summary": "Analysis completed from the available resume, profile, and job evidence.",
    }
    return _normalize_result(result, analysis_type, target, resume_record)


async def analyze_resume(
    *,
    resume_source: str,
    resume_data: Dict[str, Any],
    target_job: Any,
    analysis_type: str,
    resume_record: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    target = normalize_target_job(target_job)
    record = resume_record if isinstance(resume_record, dict) else {}
    prompt = json.dumps({
        "requested_analysis": analysis_type,
        "resume_source": resume_source,
        "candidate_profile": resume_data,
        "selected_job": target,
    }, ensure_ascii=False)
    result = await gemini.generate_json(
        system=_SYSTEM_PROMPT,
        contents=[gemini.user_turn(prompt)],
        temperature=0.1,
        max_output_tokens=2048,
        timeout=30,
    )
    if result is None:
        log.warning("resume analysis model unavailable; using the deterministic fallback")
        return _fallback_analysis(resume_source, resume_data, target, analysis_type, record)
    return _normalize_result(result, analysis_type, target, record)
