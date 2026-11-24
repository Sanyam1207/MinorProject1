"""Build a factual job-to-resume context for targeted generation."""

from __future__ import annotations

import re
from typing import Any, Dict, Iterable, List, Optional


def _first(job: Dict[str, Any], *keys: str) -> Any:
    for key in keys:
        value = job.get(key)
        if value not in (None, "", [], {}):
            return value
    return None


def _string_list(value: Any) -> List[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, str):
        return [item.strip() for item in re.split(r"[,;|]", value) if item.strip()]
    return []


def normalize_target_job(job: Any) -> Optional[Dict[str, Any]]:
    """Normalize DB and live-scraper job shapes into one prompt contract."""
    if not isinstance(job, dict) or not job:
        return None
    skills = _string_list(_first(job, "skillsRequired", "required_skills", "skills"))
    return {
        "job_id": str(_first(job, "_id", "job_id", "id") or ""),
        "title": str(_first(job, "roleTitle", "title", "job_type") or ""),
        "company": str(_first(job, "companyName", "company_name", "company") or ""),
        "description": str(_first(job, "jdText", "description") or ""),
        "requirements": str(_first(job, "requirements") or ""),
        "required_skills": skills,
        "domain": str(_first(job, "job_domain", "category") or ""),
        "experience": str(_first(job, "experience") or ""),
        "location": str(_first(job, "location") or ""),
        "application_url": str(_first(job, "applicationUrl", "application_url") or ""),
    }


def _evidence_text(resume: Dict[str, Any]) -> str:
    values: List[str] = []
    values.extend(str(skill) for skill in resume.get("skills") or [])
    for section in ("projects", "experience", "certifications", "achievements"):
        for item in resume.get(section) or []:
            if isinstance(item, dict):
                values.extend(str(value) for value in item.values())
            else:
                values.append(str(item))
    return " ".join(values).lower()


def _matched_skills(skills: Iterable[str], resume: Dict[str, Any]) -> tuple[List[str], List[str]]:
    evidence = _evidence_text(resume)
    matched: List[str] = []
    unsupported: List[str] = []
    for skill in skills:
        normalized = skill.strip().lower()
        if normalized and normalized in evidence:
            matched.append(skill)
        else:
            unsupported.append(skill)
    return matched, unsupported


def build_tailoring_context(resume: Dict[str, Any], job: Any) -> Optional[Dict[str, Any]]:
    """Describe the target and exact evidence boundary for the generation LLM."""
    target = normalize_target_job(job)
    if not target:
        return None
    matched, unsupported = _matched_skills(target["required_skills"], resume)
    return {
        "target_job": target,
        "evidence_catalog": {
            "skills": resume.get("skills") or [],
            "projects": resume.get("projects") or [],
            "experience": resume.get("experience") or [],
            "certifications": resume.get("certifications") or [],
            "achievements": resume.get("achievements") or [],
        },
        "exact_skill_matches": matched,
        "unsupported_job_skills": unsupported,
        "rules": [
            "Prioritize and rewrite only facts supported by the evidence catalog.",
            "Never add an unsupported job skill to the candidate's resume.",
            "Use the target job's terminology only where it truthfully describes existing evidence.",
        ],
    }
