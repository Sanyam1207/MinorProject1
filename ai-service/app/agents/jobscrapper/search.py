"""Deterministic job-search helpers shared by the jobs-finder and the copilot.

* ``extract_search_args`` turns a chat message into tool arguments (no LLM).
* ``campus_item`` / ``market_item`` / ``crawl_item`` map campus drives (Node
  ``jobs_search_campus``), open-market jobs (``jobs_search_market``) and jobs
  crawled from a careers URL onto ONE item shape (JOB-FEED.md §12.5), the
  ``data[i]`` of ``mode:jobparser:jobslist``.
* ``merge_items`` orders and de-duplicates a mixed result list.

Nothing here invents a job: every item is built from a tool result or from a
page the user asked us to crawl.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from typing import Any, Dict, Iterable, List, NamedTuple, Optional

from app.utils.url_utils import normalize_url

NOT_MENTIONED = "Not mentioned"
DESCRIPTION_MAX_CHARS = 1200

# Exact key order of a JobsListItem (JOB-FEED.md §12.5).
ITEM_KEYS = (
    "id", "kind", "source", "sources", "title", "company_name", "company_logo", "location",
    "job_type", "work_type", "salary", "experience", "job_domain", "skills", "description",
    "requirements", "application_url", "posted_at", "deadline", "isEligible", "eligibility_reasons",
    "min_cgpa", "match_score", "matched_skills", "application_status", "saveable", "is_sample",
)


class SearchArgs(NamedTuple):
    query: str
    job_type: Optional[str]
    work_type: Optional[str]
    location: Optional[str]


# alias (lower-case) -> canonical display name; None = no location filter.
_LOCATION_CANONICAL: Dict[str, Optional[str]] = {
    "bangalore": "Bengaluru", "bengaluru": "Bengaluru",
    "gurgaon": "Gurugram", "gurugram": "Gurugram",
    "bombay": "Mumbai", "mumbai": "Mumbai",
    "madras": "Chennai", "chennai": "Chennai",
    "calcutta": "Kolkata", "kolkata": "Kolkata",
    "cochin": "Kochi", "kochi": "Kochi",
    "trivandrum": "Thiruvananthapuram", "thiruvananthapuram": "Thiruvananthapuram",
    "vizag": "Visakhapatnam", "visakhapatnam": "Visakhapatnam",
    "mysore": "Mysuru", "mysuru": "Mysuru",
    "new delhi": "Delhi", "delhi ncr": "Delhi", "ncr": "Delhi", "delhi": "Delhi",
    "noida": "Noida", "hyderabad": "Hyderabad", "pune": "Pune", "ahmedabad": "Ahmedabad",
    "jaipur": "Jaipur", "chandigarh": "Chandigarh", "indore": "Indore", "coimbatore": "Coimbatore",
    "lucknow": "Lucknow", "nagpur": "Nagpur", "bhubaneswar": "Bhubaneswar", "surat": "Surat",
    "vadodara": "Vadodara", "bhopal": "Bhopal", "patna": "Patna", "goa": "Goa",
    "india": None,
    "london": "London", "singapore": "Singapore", "dubai": "Dubai", "berlin": "Berlin",
    "san francisco": "San Francisco", "new york": "New York", "toronto": "Toronto", "sydney": "Sydney",
}
KNOWN_LOCATIONS = tuple(sorted(_LOCATION_CANONICAL, key=len, reverse=True))
_LOCATION_ALT = "|".join(re.escape(name).replace(r"\ ", r"\s+") for name in KNOWN_LOCATIONS)
_LOCATION_PREP_RE = re.compile(rf"\b(?:in|at|near|around|based\s+in)\s+({_LOCATION_ALT})\b", re.IGNORECASE)
_LOCATION_ANY_RE = re.compile(rf"\b({_LOCATION_ALT})\b", re.IGNORECASE)

_JOB_TYPE_RULES = (
    (re.compile(r"\bintern(ship)?s?\b", re.I), "internship"),
    (re.compile(r"\bpart[\s-]?time\b", re.I), "part-time"),
    (re.compile(r"\b(contract(ual)?|freelance)\b", re.I), "contract"),
    (re.compile(r"\b(full[\s-]?time|permanent)\b", re.I), "full-time"),
)
_WORK_TYPE_RULES = (
    (re.compile(r"\b(remote|wfh|work\s+from\s+home)\b", re.I), "remote"),
    (re.compile(r"\bhybrid\b", re.I), "hybrid"),
    (re.compile(r"\b(on[\s-]?site|in[\s-]?office|wfo|work\s+from\s+office)\b", re.I), "onsite"),
)

_STOPWORDS = frozenset("""
a an the me my i im we us you your can could would will please pls kindly help find search show get give
list browse fetch look looking want need some any all few more other latest new newest recent fresh open current available good best top
job jobs role roles position positions opening openings vacancy vacancies opportunity opportunities career careers listing listings
posting postings work hiring hire for with of to in at on near around from by that which who are is there be as and or also just like
related based something anything campus drive drives intern interns internship internships remote hybrid onsite full part time fulltime
parttime contract freelance
""".split())
_MAX_QUERY_TOKENS = 6


def _canonical_location(name: str) -> Optional[str]:
    return _LOCATION_CANONICAL.get(re.sub(r"\s+", " ", name.strip().lower()))


def extract_search_args(text: str) -> SearchArgs:
    """``(query, job_type, work_type, location)`` from a chat message (JOB-FEED.md §12.4)."""
    normalized = unicodedata.normalize("NFKC", text or "").lower()
    spans: List[tuple[int, int]] = []

    job_type: Optional[str] = None
    for pattern, value in _JOB_TYPE_RULES:
        match = pattern.search(normalized)
        if match:
            job_type = value
            spans.append(match.span())
            break

    work_type: Optional[str] = None
    for pattern, value in _WORK_TYPE_RULES:
        match = pattern.search(normalized)
        if match:
            work_type = value
            spans.append(match.span())
            break

    location: Optional[str] = None
    match = _LOCATION_PREP_RE.search(normalized) or _LOCATION_ANY_RE.search(normalized)
    if match:
        location = _canonical_location(match.group(1))
        spans.append(match.span())

    remaining = list(normalized)
    for start, end in spans:
        for index in range(start, end):
            remaining[index] = " "
    leftover = _LOCATION_ANY_RE.sub(" ", "".join(remaining))

    tokens: List[str] = []
    for raw in re.findall(r"[a-z0-9+#.]+", leftover):
        token = raw.rstrip(".")
        if not token or token in _STOPWORDS or token.strip(".") == "":
            continue
        tokens.append(token)
        if len(tokens) >= _MAX_QUERY_TOKENS:
            break
    return SearchArgs(" ".join(tokens), job_type, work_type, location)


# ---------------------------------------------------------------------------
# Item builders
# ---------------------------------------------------------------------------


def _text(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    return None


def _str_or_nm(*values: Any) -> str:
    for value in values:
        text = _text(value)
        if text and text != NOT_MENTIONED:
            return text
    return NOT_MENTIONED


def _opt_str(*values: Any) -> Optional[str]:
    for value in values:
        text = _text(value)
        if text and text != NOT_MENTIONED:
            return text
    return None


def _str_list(value: Any, limit: Optional[int] = None) -> List[str]:
    if isinstance(value, str):
        items = [part.strip() for part in re.split(r"[,;|]", value) if part.strip()]
    elif isinstance(value, (list, tuple)):
        items = []
        for entry in value:
            if isinstance(entry, dict):
                entry = entry.get("name") or entry.get("label") or entry.get("title")
            text = _text(entry)
            if text and text != NOT_MENTIONED:
                items.append(text)
    else:
        items = []
    return items[:limit] if limit else items


def _number(value: Any) -> Optional[float]:
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number


def _score(value: Any) -> Optional[int]:
    number = _number(value)
    if number is None:
        return None
    return max(0, min(100, int(round(number))))


def _description(value: Any) -> str:
    text = _str_or_nm(value)
    return text[:DESCRIPTION_MAX_CHARS] if text != NOT_MENTIONED else NOT_MENTIONED


def _company_name(job: dict) -> str:
    company = job.get("company")
    if isinstance(company, str) and company.strip():
        return company.strip()
    if isinstance(company, dict):
        name = _text(company.get("name"))
        if name:
            return name
    return _str_or_nm(job.get("companyName"), job.get("company_name"))


def _selection_process(value: Any) -> Optional[str]:
    if isinstance(value, (list, tuple)):
        steps = _str_list(value)
        return " → ".join(steps) if steps else None
    return _opt_str(value)


def campus_item(c: dict, *, student: bool = True) -> Dict[str, Any]:
    """A campus drive (``jobs_search_campus`` ``data.jobs[i]``) as a JobsListItem."""
    c = c if isinstance(c, dict) else {}
    min_cgpa = _number(c.get("minimumCgpa") if c.get("minimumCgpa") is not None else c.get("minCgpa"))
    max_backlogs = c.get("maximumBacklogs") if c.get("maximumBacklogs") is not None else c.get("maxBacklogs")
    branches = _str_list(c.get("eligibleBranches") or c.get("branches"))
    batches = _str_list(c.get("graduationYears"))
    requirements: List[str] = []
    if min_cgpa is not None:
        requirements.append(f"Min CGPA {min_cgpa:g}")
    if _number(max_backlogs) is not None:
        requirements.append(f"Max backlogs {int(_number(max_backlogs))}")
    if branches:
        requirements.append("Branches: " + ", ".join(branches))
    if batches:
        requirements.append("Batch " + ", ".join(batches))
    selection = _selection_process(c.get("selectionProcess"))
    if selection:
        requirements.append(selection)

    package = _number(c.get("packageLpa"))
    salary = _str_or_nm(c.get("salary"), c.get("ctc"), f"{package:g} LPA" if package is not None else None)
    eligibility = c.get("eligibility") if isinstance(c.get("eligibility"), dict) else {}
    reasons = _str_list(c.get("eligibilityReasons") or eligibility.get("reasons"), limit=3)
    application = c.get("myApplication") if isinstance(c.get("myApplication"), dict) else {}
    is_eligible = c.get("isEligible")
    return {
        "id": str(c.get("id") or c.get("_id") or ""),
        "kind": "campus",
        "source": "campus",
        "sources": ["campus"],
        "title": _str_or_nm(c.get("title")),
        "company_name": _company_name(c),
        "company_logo": _opt_str(c.get("companyLogo")),
        "location": _str_or_nm(c.get("location")),
        "job_type": _str_or_nm(c.get("employmentType")),
        "work_type": _opt_str(c.get("workType")),
        "salary": salary,
        "experience": _str_or_nm(c.get("experience")),
        "job_domain": "Campus drive",
        "skills": _str_list(c.get("skills")),
        "description": _description(c.get("description")),
        "requirements": " · ".join(requirements) if requirements else NOT_MENTIONED,
        "application_url": _opt_str(c.get("applicationUrl")),
        "posted_at": _opt_str(c.get("createdAt")),
        "deadline": _opt_str(c.get("applicationDeadline"), c.get("deadline")),
        "isEligible": (bool(is_eligible) if isinstance(is_eligible, bool) else None) if student else None,
        "eligibility_reasons": reasons,
        "min_cgpa": min_cgpa,
        "match_score": _score(c.get("matchScore") if c.get("matchScore") is not None else c.get("matchPercentage")),
        "matched_skills": _str_list(c.get("matchedSkills")),
        "application_status": _opt_str(application.get("status"), c.get("applicationStatus")),
        "saveable": False,
        "is_sample": False,
    }


def market_item(m: dict) -> Dict[str, Any]:
    """An open-market job (``jobs_search_market`` ``data.jobs[i]``) as a JobsListItem."""
    m = m if isinstance(m, dict) else {}
    sources = _str_list(m.get("sources"))
    work_type = _opt_str(m.get("workType"))
    location = _opt_str(m.get("location"))
    if location is None and (work_type == "remote" or m.get("isRemote") is True):
        location = "Remote"
    categories = _str_list(m.get("categories"))
    saved = m.get("saved")
    saved_status = saved.get("status") if isinstance(saved, dict) else None
    return {
        "id": str(m.get("id") or m.get("_id") or ""),
        "kind": "external",
        "source": sources[0] if sources else "market",
        "sources": sources or ["market"],
        "title": _str_or_nm(m.get("title")),
        "company_name": _company_name(m),
        "company_logo": _opt_str(m.get("companyLogo")),
        "location": location or NOT_MENTIONED,
        "job_type": _str_or_nm(m.get("jobType")),
        "work_type": work_type,
        "salary": _str_or_nm(m.get("salary")),
        "experience": _str_or_nm(m.get("experience")),
        "job_domain": categories[0] if categories else "Other",
        "skills": [],
        "description": _description(m.get("description")),
        "requirements": "",
        "application_url": _opt_str(m.get("applyUrl")),
        "posted_at": _opt_str(m.get("postedAt")),
        "deadline": None,
        "isEligible": None,
        "eligibility_reasons": [],
        "min_cgpa": None,
        "match_score": _score(m.get("matchScore")),
        "matched_skills": _str_list(m.get("matchedSkills")),
        "application_status": _opt_str(saved_status),
        "saveable": True,
        "is_sample": bool(m.get("isSample")),
    }


def crawl_id(job: dict) -> str:
    url = _opt_str(job.get("application_url"))
    basis = normalize_url(url) if url else ""
    if not basis:
        basis = "|".join(
            str(job.get(key) or "").strip().lower() for key in ("title", "company", "location")
        )
    return "crawl:" + hashlib.sha1(basis.encode("utf-8")).hexdigest()[:16]


def crawl_item(j: dict) -> Dict[str, Any]:
    """A job crawled from a careers page (``Job.model_dump()``) as a JobsListItem."""
    j = j if isinstance(j, dict) else {}
    return {
        "id": crawl_id(j),
        "kind": "external",
        "source": "crawl",
        "sources": ["crawl"],
        "title": _str_or_nm(j.get("title")),
        "company_name": _str_or_nm(j.get("company"), j.get("company_name")),
        "company_logo": None,
        "location": _str_or_nm(j.get("location")),
        "job_type": _str_or_nm(j.get("employment_type"), j.get("job_type")),
        "work_type": None,
        "salary": _str_or_nm(j.get("salary"), j.get("stipend")),
        "experience": _str_or_nm(j.get("experience")),
        "job_domain": _str_or_nm(j.get("category"), j.get("job_domain")),
        "skills": _str_list(j.get("skills")),
        "description": _description(j.get("description")),
        "requirements": _str_or_nm(j.get("requirements")),
        "application_url": _opt_str(j.get("application_url")),
        "posted_at": None,
        "deadline": None,
        "isEligible": None,
        "eligibility_reasons": [],
        "min_cgpa": None,
        "match_score": None,
        "matched_skills": [],
        "application_status": None,
        "saveable": False,
        "is_sample": False,
    }


def is_list_item(value: Any) -> bool:
    """True for a dict that already has the JobsListItem shape."""
    return (
        isinstance(value, dict)
        and value.get("kind") in ("campus", "external")
        and isinstance(value.get("id"), str)
        and "saveable" in value
    )


def _campus_sort_key(item: dict):
    return (
        item.get("isEligible") is not True,
        -(item.get("match_score") or -1),
        item.get("deadline") or "9999",
    )


def merge_items(
    campus: Iterable[dict],
    market: Iterable[dict],
    *,
    campus_limit: int,
    max_results: int,
) -> List[Dict[str, Any]]:
    """Campus first (eligible, best match, nearest deadline), then market in Node's order."""
    ordered = sorted((c for c in campus if isinstance(c, dict)), key=_campus_sort_key)[: max(0, campus_limit)]
    ordered += [m for m in market if isinstance(m, dict)]
    seen: set[str] = set()
    merged: List[Dict[str, Any]] = []
    for item in ordered:
        item_id = item.get("id") or ""
        if not item_id or item_id in seen:
            continue
        seen.add(item_id)
        merged.append(item)
        if len(merged) >= max_results:
            break
    return merged


def item_label(item: dict) -> str:
    """``“<title>” at <company>`` for chat replies."""
    title = item.get("title") or "this job"
    company = item.get("company_name")
    if company and company != NOT_MENTIONED:
        return f"“{title}” at {company}"
    return f"“{title}”"


# ---------------------------------------------------------------------------
# "job 2", "the 3rd one", "the last job" -> list position (shared with the copilot)
# ---------------------------------------------------------------------------

_ORDINAL_WORDS = {
    "first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5,
    "sixth": 6, "seventh": 7, "eighth": 8, "ninth": 9, "tenth": 10,
}
_JOB_NOUN = r"(?:job|drive|one|listing|role|opening|position|posting)"
ORDINAL_REF_RE = re.compile(
    r"\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|\d{1,2}(?:st|nd|rd|th))\s+"
    + _JOB_NOUN + r"\b",
    re.IGNORECASE,
)
NUMBER_REF_RE = re.compile(
    r"\b(?:job|drive|listing|role|opening|position|posting|number|no\.?)\s*#?\s*(\d{1,2})\b|#\s*(\d{1,2})\b",
    re.IGNORECASE,
)


def job_index_from_text(text: str, count: int) -> Optional[int]:
    """1-based list position referenced by *text* (may be out of range), or None.

    ``last`` resolves to *count* (None when the list is empty).
    """
    match = ORDINAL_REF_RE.search(text or "")
    if match:
        word = match.group(1).lower()
        if word == "last":
            return count or None
        if word in _ORDINAL_WORDS:
            return _ORDINAL_WORDS[word]
        return int(re.match(r"\d+", word).group(0))
    match = NUMBER_REF_RE.search(text or "")
    if match:
        return int(match.group(1) or match.group(2))
    return None
