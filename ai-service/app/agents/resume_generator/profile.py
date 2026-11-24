"""Profile bootstrap for the Resume Generator Agent.

This module is responsible for seeding the initial ``ResumeData`` from any
profile information already available.  Currently the project has no external
profile store, so we parse whatever structured data the frontend may include
inline in ``user_query`` (as a JSON prefix).

When the project adds a profile database or user-auth service, this is the
single file to update — nothing else in the agent needs to change.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, Optional, Tuple

from app.agents.resume_generator.schemas import (
    AchievementEntry,
    CertificationEntry,
    EducationEntry,
    ExperienceEntry,
    ProjectEntry,
    ResumeData,
)
from app.schemas import QueryRequest

log = logging.getLogger("resume_agent.profile")


def normalize_profile_url(value: Any) -> str:
    """Turn pasted Markdown links into the plain URL expected by LaTeX."""
    text = str(value or "").strip()
    markdown = re.fullmatch(r"\[[^\]]*\]\((https?://[^)]+)\)", text)
    if markdown:
        return markdown.group(1).strip()
    return text


def _try_parse_profile_json(user_query: str) -> Optional[Dict[str, Any]]:
    """If the user_query starts with a JSON object that contains a ``profile``
    key, extract and return it.  Otherwise return None.

    The frontend may send:
        {"profile": {"name": "...", "email": "...", ...}, "message": "Generate my resume"}
    """
    text = (user_query or "").strip()
    if not text.startswith("{"):
        return None
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict) and "profile" in parsed:
            return parsed["profile"]
    except (json.JSONDecodeError, ValueError):
        pass
    return None


def _strip_profile_json(user_query: str) -> str:
    """Return the human message part of user_query, stripping any leading JSON."""
    text = (user_query or "").strip()
    if not text.startswith("{"):
        return text
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict) and "message" in parsed:
            return str(parsed["message"])
    except (json.JSONDecodeError, ValueError):
        pass
    return text


def seed_resume_from_profile(
    req: QueryRequest,
    resume: ResumeData,
) -> Tuple[ResumeData, str]:
    """Seed *resume* with any profile data found in *req*, and return the
    cleaned user message (profile JSON stripped out).

    Returns
    -------
    (updated_resume, clean_user_message)
    """
    profile = {}
    
    # 1. First check if the frontend sent it via the new req.meta_data field
    if req.meta_data and isinstance(req.meta_data, dict):
        # Could be under req.meta_data["profile"] or directly in req.meta_data
        profile = req.meta_data.get("profile") or req.meta_data
    
    # 2. Fallback: Try parsing inline JSON from user_query
    if not profile:
        profile = _try_parse_profile_json(req.user_query) or {}
        
    clean_message = _strip_profile_json(req.user_query)

    if not profile:
        return resume, clean_message

    log.info("seeding resume from meta_data/profile data")

    # Personal information
    p = resume.personal
    p.name = profile.get("name", "") or p.name
    p.email = profile.get("email", "") or p.email
    p.phone = profile.get("phone", "") or p.phone
    p.location = profile.get("location", "") or p.location
    p.linkedin = normalize_profile_url(profile.get("linkedin", "")) or p.linkedin
    p.github = normalize_profile_url(profile.get("github", "")) or p.github
    p.portfolio = normalize_profile_url(profile.get("portfolio", "")) or p.portfolio

    # Education — college / degree data often comes from the profile
    if any([
        profile.get("college"),
        profile.get("degree"),
        profile.get("branch"),
        profile.get("cgpa"),
        profile.get("graduation_year"),
    ]):
        edu = EducationEntry(
            institution=profile.get("college", ""),
            degree=profile.get("degree", ""),
            branch=profile.get("branch", ""),
            cgpa=str(profile.get("cgpa", "")),
            graduation_year=str(profile.get("graduation_year", "")),
            tenth_percentage=str(profile.get("tenth_percentage", "")),
            twelfth_percentage=str(profile.get("twelfth_percentage", "")),
        )
        # Only add if not already seeded from a previous request in the session
        if not resume.education:
            resume.education.append(edu)

    if profile.get("skills") and not resume.skills:
        resume.skills = [str(skill) for skill in profile["skills"] if skill]

    if profile.get("projects") and not resume.projects:
        for project in profile["projects"]:
            if not isinstance(project, dict):
                continue
            description = project.get("description", [])
            resume.projects.append(ProjectEntry(
                name=project.get("name") or project.get("title", ""),
                tech_stack=project.get("tech_stack") or ", ".join(project.get("skills", [])),
                description=description if isinstance(description, list) else [description],
                link=project.get("link", ""),
            ))

    if profile.get("experience") and not resume.experience:
        for experience in profile["experience"]:
            if not isinstance(experience, dict):
                continue
            description = experience.get("description", [])
            resume.experience.append(ExperienceEntry(
                company=experience.get("company", ""),
                role=experience.get("role") or experience.get("title", ""),
                duration=experience.get("duration", ""),
                description=description if isinstance(description, list) else [description],
            ))

    if profile.get("certifications") and not resume.certifications:
        for certification in profile["certifications"]:
            if isinstance(certification, str):
                resume.certifications.append(CertificationEntry(name=certification))
            elif isinstance(certification, dict):
                resume.certifications.append(CertificationEntry(
                    name=certification.get("name") or certification.get("title", ""),
                    issuer=certification.get("issuer", ""),
                    year=str(certification.get("year") or certification.get("date", "")),
                ))

    if profile.get("achievements") and not resume.achievements:
        for achievement in profile["achievements"]:
            if isinstance(achievement, str):
                resume.achievements.append(AchievementEntry(title=achievement))
            elif isinstance(achievement, dict):
                resume.achievements.append(AchievementEntry(
                    title=achievement.get("title") or achievement.get("name", ""),
                    description=achievement.get("description", ""),
                ))

    return resume, clean_message
