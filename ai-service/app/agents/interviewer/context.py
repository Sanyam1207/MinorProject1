"""Builds the material an interview is conducted from.

Two sources, matching the two entry options:

* ``build_job_context``     -- option 1: fetch the job link, hand the page
                               text to Gemini, get structured job details back.
* ``build_profile_context`` -- option 2: read the student's own details out of
                               ``req.meta_data``.

The fetch here follows redirects *manually*, re-running the SSRF check on
every hop. ``httpx``'s own ``follow_redirects=True`` would let a public URL
bounce to a private address after the check has already passed.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Tuple

import httpx
from bs4 import BeautifulSoup

from app.config import settings
from app.utils.text_utils import clean_text
from app.utils.url_utils import is_safe_url, validate_url
from app.agents.interviewer.llm import call_gemini_json
from app.agents.interviewer.prompt import (
    SYSTEM_PROMPT_JD,
    build_jd_from_url_user_turn,
    build_jd_user_turn,
)
from app.agents.interviewer.schemas import JobContext, ProfileContext

log = logging.getLogger("interviewer.context")

_USER_AGENT = "JobScraperBot/1.0 (+https://example.com/bot)"
_MAX_REDIRECTS = 5


# ---------------------------------------------------------------------------
# Safe fetching
# ---------------------------------------------------------------------------


async def _fetch_html(url: str, timeout: float = 12.0) -> str:
    """Download *url*, re-validating the target on every redirect hop.

    Returns the HTML, or "" if the URL is unsafe/unreachable at any hop.
    """
    current = url
    async with httpx.AsyncClient(
        timeout=timeout,
        follow_redirects=False,
        headers={"User-Agent": _USER_AGENT},
    ) as client:
        for _ in range(_MAX_REDIRECTS + 1):
            if not validate_url(current) or not is_safe_url(current):
                log.warning("refusing to fetch unsafe interview job URL: %s", current)
                return ""
            try:
                response = await client.get(current)
            except Exception as exc:
                log.warning("job page fetch failed for %s: %s", current, exc)
                return ""

            if response.is_redirect:
                location = response.headers.get("location")
                if not location:
                    return ""
                current = str(response.url.join(location))
                continue

            if response.status_code != 200:
                log.info("job page %s returned HTTP %s", current, response.status_code)
                return ""
            return response.text

    log.warning("too many redirects fetching %s", url)
    return ""


def _page_text(html: str) -> str:
    """Strip a job page down to readable text for the extraction prompt."""
    if not html:
        return ""
    soup = BeautifulSoup(html, "lxml")
    for tag in soup(["script", "style", "noscript", "svg", "nav", "footer"]):
        tag.decompose()
    text = clean_text(soup.get_text(separator=" "))
    return text[: settings.INTERVIEW_JD_MAX_CHARS]


# ---------------------------------------------------------------------------
# Option 1 -- job link
# ---------------------------------------------------------------------------


def _as_str_list(value: Any, limit: int = 12) -> List[str]:
    if not isinstance(value, list):
        return []
    return [clean_text(str(item)) for item in value if item][:limit]


def _job_from_extraction(data: Dict[str, Any], source_url: str) -> JobContext:
    return JobContext(
        job_title=clean_text(str(data.get("job_title") or "Not mentioned")),
        company=clean_text(str(data.get("company") or "Not mentioned")),
        experience_required=clean_text(str(data.get("experience_required") or "Not mentioned")),
        location=clean_text(str(data.get("location") or "Not mentioned")),
        employment_type=clean_text(str(data.get("employment_type") or "Not mentioned")),
        skills=_as_str_list(data.get("skills")),
        responsibilities=_as_str_list(data.get("responsibilities")),
        qualifications=_as_str_list(data.get("qualifications")),
        description=clean_text(str(data.get("description") or "Not mentioned")),
        source_url=source_url,
    )


async def build_job_context(url: str, user_hint: str = "") -> Tuple[Optional[JobContext], str]:
    """Turn a job link into a ``JobContext``.

    Returns ``(context, error_message)``. On success *error_message* is "".
    Falls back to URL-only inference when the page cannot be downloaded, so a
    JS-only or bot-protected careers page still yields a usable interview.
    """
    if not validate_url(url):
        return None, (
            "That doesn't look like a valid job link. Please paste the full URL, "
            "starting with http:// or https://."
        )
    if not is_safe_url(url):
        return None, "That link points to a private or internal address, so I can't open it."

    html = await _fetch_html(url)
    page_text = _page_text(html)

    if page_text and len(page_text) > 200:
        data = await call_gemini_json(
            SYSTEM_PROMPT_JD,
            build_jd_user_turn(page_text, url),
            temperature=0.2,
            max_output_tokens=1536,
        )
    else:
        log.info("job page %s yielded no usable text -- inferring from the URL", url)
        data = await call_gemini_json(
            SYSTEM_PROMPT_JD,
            build_jd_from_url_user_turn(url, user_hint),
            temperature=0.2,
            max_output_tokens=768,
        )

    if not data:
        return None, (
            "I couldn't read the details from that job link right now. "
            "You can paste the job description text directly, or pick the "
            "profile-based interview instead."
        )

    return _job_from_extraction(data, url), ""


def build_job_context_from_dict(data: Dict[str, Any]) -> JobContext:
    """Turn a database job record into a ``JobContext``."""
    if not isinstance(data, dict):
        return JobContext()

    company = data.get("company_name") or data.get("company")
    if isinstance(company, dict):
        company = company.get("name") or "Not mentioned"
    company_name = clean_text(str(company or "Not mentioned"))

    job_title = clean_text(str(data.get("job_title") or data.get("title") or "Not mentioned"))
    location = clean_text(str(data.get("location") or "Not mentioned"))
    employment_type = clean_text(str(data.get("employment_type") or data.get("employmentType") or "Not mentioned"))

    skills = _as_str_list(data.get("skills"))
    description = clean_text(str(data.get("description") or "Not mentioned"))

    responsibilities = _as_str_list(data.get("responsibilities"))
    if not responsibilities and (data.get("selection_process") or data.get("selectionProcess")):
        sel_proc = data.get("selection_process") or data.get("selectionProcess")
        responsibilities = [f"Selection process: {clean_text(str(sel_proc))}"]

    qualifications = _as_str_list(data.get("qualifications"))
    if not qualifications:
        quals = []
        branches = data.get("eligibleBranches") or data.get("allowed_branches")
        if isinstance(branches, list) and branches:
            quals.append(f"Eligible Branches: {', '.join(str(b) for b in branches)}")
        cgpa = data.get("minimumCgpa") if data.get("minimumCgpa") is not None else data.get("min_cgpa")
        if cgpa is not None:
            quals.append(f"Minimum CGPA: {cgpa}")
        if quals:
            qualifications = quals

    exp = data.get("experience_required") or data.get("experience") or "Not mentioned"
    source_url = str(data.get("source_url") or data.get("job_id") or data.get("_id") or "")

    return JobContext(
        job_title=job_title,
        company=company_name,
        experience_required=clean_text(str(exp)),
        location=location,
        employment_type=employment_type,
        skills=skills,
        responsibilities=responsibilities,
        qualifications=qualifications,
        description=description,
        source_url=source_url,
    )


def find_job_in_metadata(
    message: str,
    meta_data: Optional[Dict[str, Any]],
) -> Optional[JobContext]:
    """Find a database job in ``req.meta_data`` or match the user query to one."""
    if not meta_data:
        return None

    selected = meta_data.get("selected_job")
    if isinstance(selected, dict) and (
        selected.get("title") or selected.get("job_title") or selected.get("job_id") or selected.get("_id")
    ):
        return build_job_context_from_dict(selected)

    jobs = meta_data.get("jobs")
    if not isinstance(jobs, list) or not jobs:
        return None

    clean_msg = clean_text(message).lower()
    if not clean_msg:
        return None

    for job in jobs:
        if not isinstance(job, dict):
            continue
        job_id = str(job.get("job_id") or job.get("_id") or "").lower()
        if job_id and job_id in clean_msg:
            return build_job_context_from_dict(job)

        title = str(job.get("job_title") or job.get("title") or "").strip().lower()
        company = str(
            job.get("company_name")
            or (job.get("company", {}).get("name") if isinstance(job.get("company"), dict) else job.get("company"))
            or ""
        ).strip().lower()

        if title and title in clean_msg:
            return build_job_context_from_dict(job)
        if company and len(company) >= 3 and company in clean_msg:
            return build_job_context_from_dict(job)

    return None


# ---------------------------------------------------------------------------
# Option 2 -- the student's profile
# ---------------------------------------------------------------------------


def _as_dict_list(value: Any, limit: int = 10) -> List[Dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)][:limit]


def build_profile_context(meta_data: Optional[Dict[str, Any]]) -> ProfileContext:
    """Read the candidate's profile out of ``req.meta_data``.

    Accepts the profile either nested under a ``profile`` key or spread across
    ``meta_data`` itself -- the same tolerance ``resume_generator.profile``
    already applies to this payload.
    """
    meta = meta_data or {}
    profile = meta.get("profile") if isinstance(meta.get("profile"), dict) else meta

    return ProfileContext(
        name=clean_text(str(profile.get("name") or "")),
        branch=clean_text(str(profile.get("branch") or "")),
        degree=clean_text(str(profile.get("degree") or "")),
        graduation_year=clean_text(str(profile.get("graduation_year") or "")),
        skills=_as_str_list(profile.get("skills"), limit=25),
        projects=_as_dict_list(profile.get("projects")),
        experience=_as_dict_list(profile.get("experience")),
    )


def profile_is_usable(profile: ProfileContext) -> bool:
    """True when there is enough profile material to interview against."""
    return bool(profile.skills or profile.projects or profile.experience)
