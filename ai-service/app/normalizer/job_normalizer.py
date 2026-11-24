from typing import Dict, Any, List
from app.agents.jobscrapper.models.job import Job
from app.utils.text_utils import clean_text, NOT_MENTIONED

INVALID_VALUES = {
    "", "none", "null", "n/a", "na", "-", "--", "unknown", "undefined", "not specified", "null null"
}


def normalize_field(val: Any) -> str:
    """
    Strict Missing Information Rule:
    If a string field is missing, None, empty, or an uninformative placeholder,
    return strictly "Not mentioned".
    """
    if val is None:
        return NOT_MENTIONED

    cleaned = clean_text(str(val))
    if cleaned.lower() in INVALID_VALUES:
        return NOT_MENTIONED

    return cleaned


def normalize_job(raw: Dict[str, Any]) -> Job:
    """Convert raw extracted dictionary into fully normalized Job model."""
    title = normalize_field(raw.get("title"))
    company = normalize_field(raw.get("company"))
    location = normalize_field(raw.get("location"))
    employment_type = normalize_field(raw.get("employment_type"))
    experience = normalize_field(raw.get("experience"))
    salary = normalize_field(raw.get("salary"))
    stipend = normalize_field(raw.get("stipend"))
    description = normalize_field(raw.get("description"))
    requirements = normalize_field(raw.get("requirements"))
    posted_date = normalize_field(raw.get("posted_date"))
    application_url = normalize_field(raw.get("application_url"))
    source_url = normalize_field(raw.get("source_url"))

    # Skills handling
    skills_raw = raw.get("skills", [])
    skills: List[str] = []
    if isinstance(skills_raw, list):
        for s in skills_raw:
            norm_s = clean_text(str(s))
            if norm_s and norm_s.lower() not in INVALID_VALUES:
                skills.append(norm_s)
    skills = list(dict.fromkeys(skills))

    return Job(
        title=title if title != NOT_MENTIONED else "Job Position",
        company=company,
        category=raw.get("category", "Other"),
        subcategory=raw.get("subcategory", "General"),
        location=location,
        employment_type=employment_type,
        experience=experience,
        salary=salary,
        stipend=stipend,
        skills=skills,
        description=description,
        requirements=requirements,
        posted_date=posted_date,
        application_url=application_url,
        source_url=source_url,
    )
