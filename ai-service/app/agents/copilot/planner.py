"""Deterministic offline planner for the copilot (PYTHON.md §5.9).

Used when no Gemini key is configured or the LLM fails: regex intents map the
message to ONE tool call with extracted arguments, or to a reply (help text,
a clarifying question, a role-denied note). Every intent applies only when its
tool is in the caller's manifest, so a student can never plan a teacher tool.

The extractors are pure functions and unit-tested on their own.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from functools import cached_property
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple, Union

from app.agents.confirm import classify_reply
from app.agents.copilot.schemas import CANCELLED_TEXT, FALLBACK_UNKNOWN, humanize
from app.agents.copilot.session import AwaitingInput
from app.agents.copilot.tools_client import Manifest, ToolSpec
from app.agents.jobscrapper.search import NOT_MENTIONED, extract_search_args, item_label, job_index_from_text
from app.agents.jobscrapper.session_store import session_job_store
from app.agents.modes import AgentMode
from app.agents.roles import ROLE_DENIED_TEXT, SPECIALIST_PHRASES, specialist_modes

I = re.IGNORECASE


@dataclass
class PlannedCall:
    tool: str
    args: dict
    intent: str


@dataclass
class PlannerReply:
    text: str
    options: Optional[List[str]] = None
    awaiting: Optional[AwaitingInput] = None
    kind: str = "help"


Outcome = Union[PlannedCall, PlannerReply]

MISSING_ARG_PROMPTS: Dict[str, str] = {
    "course": "Which course? (for example CS301 or DBMS)",
    "when": "When should it be? (for example “tomorrow 10am”)",
    "job": "Which job? Mention the company or role, or say “the 2nd job” from the list.",
    "joinCode": "What's the 6-character join code your teacher shared?",
    "student": "Which student? (name, roll number or email)",
    "program": "Which training program?",
    "decision": "Do you want to accept or reject it?",
    "status": "Which status?",
}

NO_LIST_TEXT = (
    "There's no job list in this chat yet. Search first (e.g. “find data analyst internships”), "
    "then refer to a job by its number."
)
CRAWL_NOT_SAVEABLE_TEXT = (
    "That listing came from the careers page you shared and isn't in the job feed, so it can't be saved. "
    "Use its Apply link instead."
)

# ---------------------------------------------------------------------------
# Patterns
# ---------------------------------------------------------------------------

CLASS_WORD_RE = re.compile(r"\b(class|classes|lecture|lectures|lab|labs|tutorial|tutorials|session)\b", I)
_SCHEDULE_VERB_RE = re.compile(r"(?<!my\s)(?<!the\s)\b(schedule|book|plan|arrange|organi[sz]e|set\s*up)\b", I)
_SCHEDULE_ADD_RE = re.compile(
    r"\b(add|find|create|keep)\b[^.?!]{0,30}\b(class|classes|lecture|lectures|lab|tutorial|slot|extra\s+class)\b", I
)
AUTO_RE = re.compile(
    r"\b(auto(matic(ally)?)?|free\s+slot|any\s+(free\s+)?(time|slot)|whenever|best\s+time|find\s+(a|me\s+a)\s+(slot|time))\b",
    I,
)
WEEKDAY = r"(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thur?s?|fri|sat|sun)"
MONTH = r"(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)"
DATE_RES = tuple(re.compile(p, I) for p in (
    r"\bday\s+after\s+tomorrow\b",
    r"\b(today|tonight|tomorrow|tmrw|tmr)\b",
    rf"\b(next|this|coming)\s+(week|{WEEKDAY})\b",
    rf"\b(on\s+)?{WEEKDAY}\b",
    rf"\b\d{{1,2}}(st|nd|rd|th)?\s+(of\s+)?{MONTH}\b(\s+\d{{4}})?",
    rf"\b{MONTH}\s+\d{{1,2}}(st|nd|rd|th)?\b(,?\s+\d{{4}})?",
    r"\b\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?)?",
    r"\b\d{1,2}/\d{1,2}(/\d{2,4})?\b",
))
TIME_RES = tuple(re.compile(p, I) for p in (
    r"\b(at\s+)?\d{1,2}(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.)(?![a-z])",
    r"\b(at\s+)?\d{1,2}:\d{2}\b",
    r"\bat\s+\d{1,2}\b(?!\s*(%|days?|hours?|mins?|minutes?|students?))",
    r"\b(at\s+)?(noon|midnight)\b",
    r"\b(in\s+the\s+)?(morning|afternoon|evening)\b",
))
RANGE_RE = re.compile(
    r"\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|to|till|until)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b", I
)
_ISO_RE = re.compile(r"^\s*\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?\s*$", I)
_FROM_TO_RE = re.compile(r"\bfrom\b(.+?)\bto\b(.+)$", I)

_DURATION_HOURS_RE = re.compile(
    r"(?<!in\s)\b(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours)\b(?:\s*(?:and\s*)?(\d+)\s*(m|min|mins|minute|minutes)\b)?", I
)
_DURATION_MINUTES_RE = re.compile(r"(?<!in\s)\b(\d+)\s*(m|min|mins|minute|minutes)\b", I)
_DURATION_WORDS = (
    (re.compile(r"\b(one\s+and\s+a\s+half|1\.5)\s+hours?\b", I), 90),
    (re.compile(r"\bhalf\s+(an\s+)?hour\b", I), 30),
    (re.compile(r"\b(an|one)\s+hour\b", I), 60),
    (re.compile(r"\btwo\s+hours\b", I), 120),
)

_ROOM_RES = (
    re.compile(r"\b(?:in|at)\s+(?:room\s+)?((?:LT|LH|CR|LAB|HALL)[\s-]?\d{1,4}[A-Za-z]?)\b", I),
    re.compile(r"\broom\s+([A-Za-z]?\d{1,4}[A-Za-z]?)\b", I),
    re.compile(r"\bin\s+(\d{3,4}[A-Za-z]?)\b", I),
)

_CODE_RE = re.compile(r"\b([A-Za-z]{2,5})[\s-]?(\d{2,4}[A-Za-z]?)\b")
_MONTH_WORDS = set(re.findall(r"[a-z]+", MONTH))
_CODE_STOP = {
    "room", "at", "in", "on", "for", "to", "from", "by", "till", "until", "and", "the", "my", "lt", "lh", "cr",
    "lab", "hall", "sec", "section", "year", "batch", "sem", "below", "under", "above", "over", "about", "after",
    "before", "next", "last", "job", "drive", "no", "num", "number", "day", "days", "hour", "hours", "min",
    "mins", "week", "weeks", "top", "class", "code",
} | _MONTH_WORDS
_NAME_STOP = {
    "a", "an", "the", "my", "our", "next", "this", "that", "extra", "new", "first", "last", "morning", "evening",
    "afternoon", "online", "offline", "live", "each", "every", "today", "tomorrow", "one", "any", "some", "all",
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
    # additions: words that are never a course name
    "with", "for", "to", "of", "in", "on", "at", "by", "from", "code", "report", "attendance", "session",
    "sessions", "class", "classes", "lecture", "lectures", "schedule", "a.m", "p.m",
}
_ACRONYM_STOP = {"QR", "AM", "PM", "LT", "LH", "CR", "LAB", "HALL", "ID", "OK", "TPO", "HOD", "CGPA", "PDF", "CV",
                 "HR", "IST", "UTC", "GMT", "ASAP", "I", "ATS"}
_COURSE_FOR_CLASS_RE = re.compile(
    r"\b(?:for|of|in)\s+(?:the\s+|my\s+|our\s+)?([A-Za-z][\w&+.\-]*(?:\s+[A-Za-z][\w&+.\-]*){0,3}?)\s+"
    r"(?:class|classes|lecture|lectures|course|lab|tutorial|session)\b",
    I,
)
_COURSE_BEFORE_CLASS_RE = re.compile(r"\b([A-Za-z][\w&+.\-]{1,30})\s+(?:class|classes|lecture|lectures|lab|tutorial)\b", I)
_COURSE_AFTER_WORD_RE = re.compile(r"\bcourse\s+([A-Za-z0-9][\w&+.\-]{1,30})\b", I)
_COURSE_ACRONYM_AFTER_PREP_RE = re.compile(r"\b(?i:for|of|in)\s+(?i:(?:the|my|our)\s+)?([A-Z][A-Z0-9&+]{1,7})\b")
_COURSE_ACRONYM_AFTER_VERB_RE = re.compile(
    r"\b(?i:schedule|book|plan|arrange|cancel|start|begin|reschedule|postpone|prepone|move|shift|end|take)\s+"
    r"(?i:(?:the|my|our|an?)\s+)?([A-Z][A-Z0-9&+]{1,7})\b"
)
_THIS_COURSE_RE = re.compile(r"\b(this|current|the\s+same)\s+(course|class|subject)\b", I)

_TOPIC_RES = (
    re.compile(r"\btopic\s*(?:is|:|-)?\s*[\"“]?([^\"”.;\n]{3,80})", I),
    re.compile(r"\babout\s+([^.;\n]{3,80})$", I),
)
_WITHIN_RE = re.compile(
    r"\b(this\s+week|next\s+week|next\s+\d{1,2}\s+days|within\s+\d{1,2}\s+days|in\s+the\s+next\s+\d{1,2}\s+days)\b", I
)
_THRESHOLD_RES = (
    re.compile(r"\b(\d{2})\s*(%|percent)", I),
    re.compile(r"\b(below|under|less\s+than)\s+(\d{2})\b", I),
)
_JOIN_CODE_RES = (
    re.compile(r"\bcode\s*(?:is|:|=)?\s*([A-Za-z0-9]{6})\b", I),
    re.compile(r"\b([A-HJ-NP-Z2-9]{6})\b"),
)
_ATTENDANCE_STATUS_RE = re.compile(r"\b(present|absent|late|excused)\b", I)
_APPLICATION_STATUSES = (
    (re.compile(r"\bapplied\b", I), "applied"),
    (re.compile(r"\bshortlist(ed)?\b", I), "shortlisted"),
    (re.compile(r"\b(test|assessment)\b", I), "test"),
    (re.compile(r"\binterviews?\b", I), "interview"),
    (re.compile(r"\b(offered|offer)\b", I), "offered"),
    (re.compile(r"\b(rejected|rejection)\b", I), "rejected"),
    (re.compile(r"\bwithdrawn\b", I), "withdrawn"),
)
_DECISION_RES = ((re.compile(r"\baccept\b", I), "accept"), (re.compile(r"\b(reject|decline)\b", I), "reject"))
_REASON_RE = re.compile(r"\b(?:because(?:\s+of)?|due\s+to|reason\s*(?:is|:)?)\s+(.{3,160})$", I)
_HEX_ID_RE = re.compile(r"\b([0-9a-fA-F]{24})\b")
_PRONOUN_RE = re.compile(
    r"\b(this|that|the\s+same|the\s+selected)\s+(job|drive|role|one|position|opening|posting)\b|\bit\b", I
)

# ---------------------------------------------------------------------------
# Extractors (pure)
# ---------------------------------------------------------------------------


def _normalize(text: str) -> str:
    cleaned = (text or "").replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    return re.sub(r"\s+", " ", cleaned).strip()


def _to_24h(hour: int, meridiem: Optional[str]) -> int:
    meridiem = (meridiem or "").lower()
    if meridiem == "pm" and hour != 12:
        return hour + 12
    if meridiem == "am" and hour == 12:
        return 0
    return hour


def _range_start(match: re.Match) -> Tuple[str, Optional[int]]:
    """Start of "10-11am" as text ("10am") and the range length in minutes."""
    h1, m1, mer1, h2, m2, mer2 = match.groups()
    hour1, minute1 = int(h1), int(m1 or 0)
    hour2, minute2 = int(h2), int(m2 or 0)
    end = _to_24h(hour2, mer2) * 60 + minute2
    if mer1:
        meridiem = mer1.lower()
    else:
        meridiem = mer2.lower()
        if _to_24h(hour1, meridiem) * 60 + minute1 > end:
            meridiem = "am" if meridiem == "pm" else "pm"
    start = _to_24h(hour1, meridiem) * 60 + minute1
    length = end - start if end > start else None
    text = f"{hour1}{':' + m1 if m1 else ''}{meridiem}"
    return text, length


def _when_spans(text: str) -> List[Tuple[int, int, str]]:
    candidates: List[Tuple[int, int, str]] = []
    for match in RANGE_RE.finditer(text):
        start_text, _ = _range_start(match)
        candidates.append((match.start(), match.end(), start_text))
    for pattern in (*DATE_RES, *TIME_RES):
        for match in pattern.finditer(text):
            if match.end() > match.start():
                candidates.append((match.start(), match.end(), match.group(0)))
    candidates.sort(key=lambda span: (-(span[1] - span[0]), span[0]))
    chosen: List[Tuple[int, int, str]] = []
    for span in candidates:
        if all(span[1] <= other[0] or span[0] >= other[1] for other in chosen):
            chosen.append(span)
    chosen.sort(key=lambda span: span[0])
    return chosen


def extract_when(text: str) -> Optional[str]:
    """Date/time expressions in text order ("tomorrow at 10am", "next monday 2:30 pm")."""
    text = _normalize(text)
    if not text:
        return None
    if _ISO_RE.match(text):
        return text.strip()
    spans = _when_spans(text)
    if not spans:
        return None
    joined = " ".join(re.sub(r"\s+", " ", span[2].strip()) for span in spans).strip()
    joined = re.sub(r"^on\s+", "", joined, flags=I).strip()
    return joined or None


def extract_from_when(text: str) -> Tuple[Optional[str], Optional[str]]:
    """Reschedule: ``(from, when)`` -- "from friday to monday 11am" -> ("friday", "monday 11am")."""
    match = _FROM_TO_RE.search(_normalize(text))
    if match:
        return extract_when(match.group(1)), extract_when(match.group(2))
    return None, extract_when(text)


def _duration_spans(text: str) -> List[Tuple[int, int]]:
    spans = [m.span() for m in _DURATION_HOURS_RE.finditer(text)]
    spans += [m.span() for m in _DURATION_MINUTES_RE.finditer(text)]
    spans += [m.span() for pattern, _ in _DURATION_WORDS for m in pattern.finditer(text)]
    return spans


def extract_duration_minutes(text: str) -> Optional[int]:
    text = _normalize(text)
    minutes: Optional[float] = None
    match = _DURATION_HOURS_RE.search(text)
    if match:
        minutes = float(match.group(1)) * 60 + (int(match.group(3)) if match.group(3) else 0)
    else:
        match = _DURATION_MINUTES_RE.search(text)
        if match:
            minutes = float(match.group(1))
        else:
            for pattern, value in _DURATION_WORDS:
                if pattern.search(text):
                    minutes = float(value)
                    break
            else:
                range_match = RANGE_RE.search(text)
                if range_match:
                    _, length = _range_start(range_match)
                    minutes = float(length) if length else None
    if minutes is None:
        return None
    value = int(round(minutes))
    return value if 15 <= value <= 300 else None


def extract_room(text: str) -> Optional[str]:
    text = _normalize(text)
    for pattern in _ROOM_RES:
        match = pattern.search(text)
        if match:
            return match.group(1)
    return None


def _strip_spans(text: str, spans: Sequence[Tuple[int, int]]) -> str:
    chars = list(text)
    for start, end in spans:
        for index in range(max(0, start), min(len(chars), end)):
            chars[index] = " "
    return re.sub(r"\s+", " ", "".join(chars))


def _course_text(text: str) -> str:
    """The message with date/time, room and duration spans removed."""
    text = _normalize(text)
    spans: List[Tuple[int, int]] = [(start, end) for start, end, _ in _when_spans(text)]
    for pattern in _ROOM_RES:
        spans += [m.span() for m in pattern.finditer(text)]
    spans += _duration_spans(text)
    return _strip_spans(text, spans)


def _ok_name(name: str) -> bool:
    words = name.strip().lower().split()
    return bool(words) and not all(word in _NAME_STOP for word in words) and words[0] not in _NAME_STOP


def extract_course(text: str, ui_context: Optional[dict] = None) -> Optional[str]:
    cleaned = _course_text(text)
    for match in _CODE_RE.finditer(cleaned):
        letters, digits = match.group(1), match.group(2)
        if letters.lower() in _CODE_STOP:
            continue
        return f"{letters}{digits}".upper()
    for pattern in (_COURSE_FOR_CLASS_RE, _COURSE_BEFORE_CLASS_RE, _COURSE_AFTER_WORD_RE):
        for match in pattern.finditer(cleaned):
            name = match.group(1).strip()
            if name and _ok_name(name):
                return name
    for pattern in (_COURSE_ACRONYM_AFTER_PREP_RE, _COURSE_ACRONYM_AFTER_VERB_RE):
        for match in pattern.finditer(cleaned):
            name = match.group(1)
            if name not in _ACRONYM_STOP and name.lower() not in _NAME_STOP:
                return name
    if _THIS_COURSE_RE.search(_normalize(text)):
        params = (ui_context or {}).get("params") if isinstance(ui_context, dict) else None
        course_id = params.get("courseId") if isinstance(params, dict) else None
        if isinstance(course_id, str) and course_id.strip():
            return course_id.strip()
    return None


def extract_topic(text: str) -> Optional[str]:
    text = _normalize(text)
    for pattern in _TOPIC_RES:
        match = pattern.search(text)
        if match:
            topic = match.group(1)
            spans = [(s, e) for s, e, _ in _when_spans(topic)]
            topic = _strip_spans(topic, spans).strip(" ,-:\"'")
            if len(topic) >= 3:
                return topic
    return None


def extract_within(text: str) -> Optional[str]:
    match = _WITHIN_RE.search(_normalize(text))
    return match.group(1) if match else None


def extract_days(text: str) -> Optional[int]:
    lowered = _normalize(text).lower()
    match = re.search(r"\bnext\s+(\d{1,2})\s+days\b", lowered)
    if match:
        return int(match.group(1))
    if re.search(r"\bnext\s+week\b", lowered):
        return 14
    if re.search(r"\bweek\b", lowered):
        return 7
    if re.search(r"\b(tomorrow|tmrw|tmr)\b", lowered):
        return 2
    if re.search(r"\btoday\b", lowered):
        return 1
    return None


def extract_threshold(text: str) -> Optional[int]:
    text = _normalize(text)
    match = _THRESHOLD_RES[0].search(text)
    if match:
        return int(match.group(1))
    match = _THRESHOLD_RES[1].search(text)
    if match:
        return int(match.group(2))
    return None


def extract_join_code(text: str) -> Optional[str]:
    text = _normalize(text)
    match = _JOIN_CODE_RES[0].search(text)
    if match:
        return match.group(1).upper()
    match = _JOIN_CODE_RES[1].search(text)
    return match.group(1) if match else None


def extract_attendance_status(text: str) -> Optional[str]:
    match = _ATTENDANCE_STATUS_RE.search(_normalize(text))
    return match.group(1).lower() if match else None


def extract_application_status(text: str) -> Optional[str]:
    text = _normalize(text)
    best: Optional[Tuple[int, str]] = None
    for pattern, value in _APPLICATION_STATUSES:
        match = pattern.search(text)
        if match and (best is None or match.start() < best[0]):
            best = (match.start(), value)
    return best[1] if best else None


def extract_decision(text: str) -> Optional[str]:
    text = _normalize(text)
    for pattern, value in _DECISION_RES:
        if pattern.search(text):
            return value
    return None


def extract_reason(text: str) -> Optional[str]:
    match = _REASON_RE.search(_normalize(text))
    return match.group(1).strip(" .") if match else None


def extract_date(text: str) -> Optional[str]:
    """A day for session reports ("today", "yesterday", "monday", an ISO date)."""
    lowered = _normalize(text).lower()
    if re.search(r"\byesterday\b", lowered):
        return "yesterday"
    spans = [span for span in _when_spans(_normalize(text))
             if any(pattern.fullmatch(span[2]) for pattern in DATE_RES)]
    if spans:
        return re.sub(r"^on\s+", "", spans[0][2].strip(), flags=I)
    return None


# ---------------------------------------------------------------------------
# Job references ("the 2nd job", "it", "Infosys")
# ---------------------------------------------------------------------------

_FREE_TEXT_RES: Dict[str, re.Pattern] = {
    "apply": re.compile(r"\bapply\s+(?:to|for)\s+(?P<ref>.+)$", I),
    "withdraw": re.compile(r"\b(?:withdraw|cancel)\b[^.?!]*?\b(?:to|for|from|with)\s+(?P<ref>.+)$", I),
    "tailor": re.compile(r"\btailor\b[^.?!]{0,30}\b(?:resume|cv)\b[^.?!]*?\b(?:for|to)\s+(?P<ref>.+)$", I),
    "offer": re.compile(r"\b(?:accept|reject|decline)\b\s+(?P<ref>.*?)\s*\boffer\b", I),
    "close": re.compile(r"\bclose\b\s+(?P<ref>.*?)\s*\b(?:drive|job|posting)\b", I),
    "applicants": re.compile(r"\b(?:applicants|candidates|applications)\s+(?:for|of|to)\s+(?P<ref>.+)$", I),
}
_LEADING_RE = re.compile(r"^(?:(?:the|a|an|my|this)\s+)+", I)
_TRAILING_RE = re.compile(r"(?:\s+(?:drive|job|role|position|opening|posting|offer|please|now))+$", I)


def _clean_ref(text: str) -> str:
    ref = text.strip().strip("\"'“”").strip()
    ref = re.sub(r"[\s.,!?;:]+$", "", ref)
    previous = None
    while previous != ref:
        previous = ref
        ref = _LEADING_RE.sub("", ref).strip()
        ref = _TRAILING_RE.sub("", ref).strip()
        ref = re.sub(r"[\s.,!?;:]+$", "", ref)
    return ref


def _item_position(jobs: List[dict], item: dict) -> Optional[int]:
    for position, job in enumerate(jobs, 1):
        if job.get("id") and job.get("id") == item.get("id"):
            return position
    return None


def _check_item(item: dict, position: Optional[int], mode: str) -> Union[str, PlannerReply, None]:
    job_id = str(item.get("id") or "")
    if not job_id:
        return None
    label = item_label(item)
    number = position or 1
    if mode in ("save", "applied"):
        if item.get("kind") == "campus":
            if mode == "save":
                return PlannerReply(
                    f"{label} is a campus drive — campus drives are tracked in Applications, not the saved list. "
                    f"Say “apply to job {number}” to apply.",
                    kind="info",
                )
            return PlannerReply(
                f"{label} is a campus drive — apply in the portal (say “apply to job {number}”) and its status will "
                "appear under Applications.",
                kind="info",
            )
        if job_id.startswith("crawl:") or item.get("source") == "crawl":
            return PlannerReply(CRAWL_NOT_SAVEABLE_TEXT, kind="info")
    if mode == "apply" and item.get("kind") == "external":
        link = item.get("application_url")
        where = f" ({link})" if link else ""
        return PlannerReply(
            f"{label} is an open-market listing — apply on the company's site{where}, then say "
            f"“mark job {number} as applied” to track it.",
            kind="info",
        )
    return job_id


def resolve_job_ref(
    text: str,
    *,
    session_id: str,
    selected_job: Optional[dict] = None,
    ui_context: Optional[dict] = None,
    mode: str = "apply",
) -> Union[str, PlannerReply, None]:
    """A job id (or free-text label), a reply explaining why not, or None."""
    text = _normalize(text)
    jobs = session_job_store.get_jobs(session_id)

    match = _HEX_ID_RE.search(text)
    if match:
        job_id = match.group(1)
        listed = next((job for job in jobs if job.get("id") == job_id), None)
        return _check_item(listed, _item_position(jobs, listed), mode) if listed else job_id

    index = job_index_from_text(text, len(jobs))
    if index is not None:
        if not jobs:
            return PlannerReply(NO_LIST_TEXT, kind="clarify")
        if not 1 <= index <= len(jobs):
            return PlannerReply(
                f"I can only see {len(jobs)} job(s) in the list right now — which one do you mean?", kind="clarify"
            )
        return _check_item(jobs[index - 1], index, mode)

    if _PRONOUN_RE.search(text):
        params = (ui_context or {}).get("params") if isinstance(ui_context, dict) else None
        ui_job = params.get("jobId") if isinstance(params, dict) else None
        if isinstance(ui_job, str) and ui_job.strip():
            listed = next((job for job in jobs if job.get("id") == ui_job.strip()), None)
            return _check_item(listed, _item_position(jobs, listed), mode) if listed else ui_job.strip()
        if isinstance(selected_job, dict):
            selected_id = selected_job.get("_id") or selected_job.get("id") or selected_job.get("job_id")
            if selected_id:
                listed = next((job for job in jobs if job.get("id") == str(selected_id)), None)
                if listed:
                    return _check_item(listed, _item_position(jobs, listed), mode)
                return str(selected_id)
        last = session_job_store.get_last_viewed_job(session_id)
        if last and last.get("id"):
            return _check_item(last, _item_position(jobs, last), mode)
        if len(jobs) == 1:
            return _check_item(jobs[0], 1, mode)

    if mode in ("save", "applied"):
        return None
    pattern = _FREE_TEXT_RES.get(mode)
    if pattern is None:
        return None
    match = pattern.search(text)
    if not match:
        return None
    ref = _clean_ref(match.group("ref"))
    return ref if len(ref) >= 2 and ref.lower() not in ("it", "this", "that", "one") else None


# ---------------------------------------------------------------------------
# Intents
# ---------------------------------------------------------------------------


class _Msg:
    def __init__(
        self,
        text: str,
        *,
        role: Optional[str],
        manifest: Manifest,
        session_id: str,
        selected_job: Optional[dict],
        ui_context: Optional[dict],
        actor_name: Optional[str] = None,
        denied_mode: Optional[AgentMode] = None,
    ) -> None:
        self.raw = text or ""
        self.text = _normalize(text)
        self.role = role
        self.manifest = manifest
        self.session_id = session_id
        self.selected_job = selected_job
        self.ui_context = ui_context if isinstance(ui_context, dict) else {}
        self.actor_name = actor_name
        self.denied_mode = denied_mode

    def has(self, pattern: str) -> bool:
        return re.search(pattern, self.text, I) is not None

    def search(self, pattern: str) -> Optional[re.Match]:
        return re.search(pattern, self.text, I)

    @cached_property
    def when(self) -> Optional[str]:
        return extract_when(self.text)

    @cached_property
    def course(self) -> Optional[str]:
        return extract_course(self.text, self.ui_context)

    @cached_property
    def class_word(self) -> bool:
        return CLASS_WORD_RE.search(self.text) is not None

    @cached_property
    def schedule(self) -> bool:
        return bool(
            (_SCHEDULE_VERB_RE.search(self.text) and (self.class_word or self.course))
            or _SCHEDULE_ADD_RE.search(self.text)
        )

    def job(self, mode: str) -> Union[str, PlannerReply, None]:
        return resolve_job_ref(
            self.text, session_id=self.session_id, selected_job=self.selected_job,
            ui_context=self.ui_context, mode=mode,
        )


Builder = Callable[[_Msg], Union[Dict[str, Any], PlannerReply, None]]


@dataclass(frozen=True)
class _Intent:
    name: str
    tool: Optional[str]
    matches: Callable[[_Msg], bool]
    build: Builder
    required: Tuple[str, ...] = ()


def _job_args(m: _Msg, mode: str, **extra: Any) -> Union[Dict[str, Any], PlannerReply]:
    ref = m.job(mode)
    if isinstance(ref, PlannerReply):
        return ref
    return {"job": ref, **extra}


def _mark_manual_args(m: _Msg) -> Optional[Dict[str, Any]]:
    match = re.search(
        r"\bmark\s+(?:student\s+)?(?P<student>.+?)\s+(?:as\s+)?(?P<status>present|absent|late|excused)\b", m.text, I
    )
    if not match:
        return None
    student = match.group("student").strip(" ,")
    if student.lower() in ("me", "myself", "my attendance", "all", "everyone", "everybody", "all students"):
        return None
    return {"student": student, "status": match.group("status").lower()}


def _training_program(m: _Msg) -> Optional[str]:
    match = re.search(
        r"\b(?:register|enrol+|sign\s+up|join)\b(?:\s+me)?\s+(?:(?:for|in|to|into|on)\s+)?(?P<rest>.+)$", m.text, I
    )
    if not match:
        return None
    ref = match.group("rest")
    ref = re.sub(r"^(?:(?:the|a|an|my|this)\s+)+", "", ref.strip(), flags=I)
    ref = re.sub(r"(?:\s+(?:training|program(?:me)?s?|workshops?|bootcamps?|course|please|now))+\s*[.!?]*$", "", ref, flags=I)
    ref = re.sub(r"^(?:training|program(?:me)?|workshop|bootcamp)\s+(?:on|for|in)\s+", "", ref.strip(), flags=I)
    ref = ref.strip(" .,!?")
    return ref if len(ref) >= 2 and ref.lower() not in ("training", "program", "programme", "workshop", "bootcamp") else None


def _drives_status(m: _Msg) -> Optional[str]:
    match = m.search(r"\b(active|closed|draft|pending)\b")
    return match.group(1).lower() if match else None


def _greeting(m: _Msg) -> PlannerReply:
    first = (m.actor_name or "").split()[0] if (m.actor_name or "").split() else ""
    hello = f"Hi {first}! " if first else "Hi there! "
    return PlannerReply(hello + capabilities_markdown(m.role or "student", m.manifest), kind="greeting")


_CAMPUS_TRIGGER_RE = re.compile(r"\b(placement|eligible|on[-\s]campus|am|i'?m|for\s+me)\b", I)
_SCHEDULE_NEG = r"\b(cancel|reschedule|postpone|prepone|move|shift|push|book|arrange)\b"

INTENTS: Tuple[_Intent, ...] = (
    _Intent("help", None,
            lambda m: m.has(r"\b(what\s+can\s+you\s+do|how\s+can\s+you\s+help|what\s+do\s+you\s+do|your\s+(features|capabilities))\b|^\s*(help|menu|options)\s*[?!.]*\s*$"),
            lambda m: PlannerReply(capabilities_markdown(m.role or "student", m.manifest), kind="help")),
    _Intent("greeting", None,
            lambda m: m.has(r"^\s*(hi+|hello|hey|hiya|namaste|good\s+(morning|afternoon|evening))\b[\s!.,]*(there|copilot|assistant)?[\s!.]*$"),
            _greeting),
    _Intent("notifications_mark_read", "notifications_mark_read",
            lambda m: m.has(r"\bmark\b[^.?!]{0,20}\b(notifications?|alerts?)\b[^.?!]{0,15}\bread\b|\b(clear|read)\s+all\s+(my\s+)?notifications\b"),
            lambda m: {"all": True}),
    _Intent("notifications_list", "notifications_list",
            lambda m: m.has(r"\b(notifications?|alerts|unread)\b"),
            lambda m: {"unreadOnly": True if m.has(r"\b(unread|new)\b") else None}),
    _Intent("attendance_join_course", "attendance_join_course",
            lambda m: m.has(r"\bjoin\b[^.?!]{0,40}\b(course|class)\b|\bjoin\s+code\b"),
            lambda m: {"joinCode": extract_join_code(m.text)}, ("joinCode",)),
    _Intent("attendance_open_scanner", "attendance_open_scanner",
            lambda m: m.has(r"\b(scan|scanner)\b|\bmark\s+my\s+attendance\b|\b(open|show)\b[^.?!]{0,15}\bqr\b"),
            lambda m: {}),
    _Intent("attendance_my_schedule", "attendance_my_schedule",
            lambda m: m.has(
                r"\b(show|view|see|check|what'?s|what\s+is|list|get)\b[^.?!]{0,15}\b(my\s+)?(schedule|timetable|time\s+table|classes|lectures)\b"
                r"|\bmy\s+(schedule|timetable|classes|lectures|next\s+class)\b|\b(classes|lectures)\s+(today|tomorrow|this\s+week|next\s+week)\b"
                r"|\bupcoming\s+classes\b"
            ) and not m.has(_SCHEDULE_NEG),
            lambda m: {"days": extract_days(m.text)}),
    _Intent("attendance_cancel_class", "attendance_cancel_class",
            lambda m: m.has(r"\bcancel\b") and (m.class_word or bool(m.course)) and not m.has(r"\bapplication\b"),
            lambda m: {"course": m.course, "when": m.when, "reason": extract_reason(m.text)}),
    _Intent("attendance_reschedule_class", "attendance_reschedule_class",
            lambda m: m.has(r"\b(reschedule|postpone|prepone|move|shift|push)\b") and (m.class_word or bool(m.course)) and bool(m.when),
            lambda m: (lambda frm, when: {
                "course": m.course, "from": frm, "when": when, "durationMinutes": extract_duration_minutes(m.text),
            })(*extract_from_when(m.text)),
            ("when",)),
    _Intent("attendance_auto_schedule_class", "attendance_auto_schedule_class",
            lambda m: m.schedule and (AUTO_RE.search(m.text) is not None or not m.when),
            lambda m: {
                "course": m.course, "durationMinutes": extract_duration_minutes(m.text),
                "within": extract_within(m.text), "topic": extract_topic(m.text),
            },
            ("course",)),
    _Intent("attendance_schedule_class", "attendance_schedule_class",
            lambda m: m.schedule and bool(m.when),
            lambda m: {
                "course": m.course, "when": m.when, "durationMinutes": extract_duration_minutes(m.text),
                "room": extract_room(m.text), "topic": extract_topic(m.text),
            },
            ("course", "when")),
    _Intent("attendance_start_session", "attendance_start_session",
            lambda m: (m.has(r"\b(start|begin|open|launch|take)\b") and (m.has(r"\b(attendance|class|session|lecture|qr)\b") or bool(m.course)))
            or m.has(r"\b(show|generate|display|project)\b[^.?!]{0,20}\bqr\b"),
            lambda m: {"course": m.course}),
    _Intent("attendance_end_session", "attendance_end_session",
            lambda m: m.has(r"\b(end|stop|close|finish|wrap\s+up)\b[^.?!]{0,25}\b(attendance|class|session|lecture)\b"),
            lambda m: {}),
    _Intent("attendance_mark_manual", "attendance_mark_manual",
            lambda m: _mark_manual_args(m) is not None,
            lambda m: _mark_manual_args(m),
            ("student", "status")),
    _Intent("attendance_notify_defaulters", "attendance_notify_defaulters",
            lambda m: m.has(r"\b(notify|warn|remind|alert|message|email)\b[^.?!]{0,30}\b(defaulters?|students?\s+(below|under|with\s+(low|less)))\b"),
            lambda m: {"course": m.course, "threshold": extract_threshold(m.text)},
            ("course",)),
    _Intent("attendance_course_report", "attendance_course_report",
            lambda m: m.has(r"\b(defaulters?|low\s+attendance|below\s+\d{2}\s*%?)\b|\battendance\s+(report|analytics|summary)\s+(for|of)\b")
            or (m.has(r"\battendance\b") and bool(m.course)),
            lambda m: {"course": m.course, "threshold": extract_threshold(m.text)},
            ("course",)),
    _Intent("attendance_session_report", "attendance_session_report",
            lambda m: m.has(r"\b(who\s+(was|were)\s+(absent|present)|today'?s\s+attendance|session\s+report)\b"
                            r"|\battendance\s+(of|for)\s+(today|yesterday|the\s+(last|latest)\s+(class|session))\b"),
            lambda m: {"course": m.course, "date": extract_date(m.text)}),
    _Intent("attendance_list_courses", "attendance_list_courses",
            lambda m: m.has(r"\b(my|list|show|which)\b[^.?!]{0,15}\bcourses\b"),
            lambda m: {}),
    _Intent("attendance_my_summary", "attendance_my_summary",
            lambda m: m.has(r"\battendance\b|\bam\s+i\s+short\b|\bcan\s+i\s+(skip|bunk|miss)\b"),
            lambda m: {}),
    _Intent("attendance_session_report_fallback", "attendance_session_report",
            lambda m: m.has(r"\battendance\b"),
            lambda m: {"course": m.course}),
    _Intent("applications_list", "applications_list",
            lambda m: m.has(r"\bmy\s+(job\s+)?applications?\b|\bapplication\s+status\b|\bstatus\s+of\s+my\s+applications?\b"
                            r"|\bwhere\s+(have\s+)?i\s+applied\b|\bapplied\s+(jobs|drives)\b")
            and not m.has(r"\b(withdraw|cancel)\b"),
            lambda m: {"status": extract_application_status(re.sub(r"\bapplications?\b|\bapplied\s+(jobs|drives)\b|\bwhere\s+(have\s+)?i\s+applied\b", " ", m.text, flags=I))}),
    _Intent("application_withdraw", "application_withdraw",
            lambda m: m.has(r"\b(withdraw|cancel)\b[^.?!]{0,40}\bapplication\b"),
            lambda m: _job_args(m, "withdraw"),
            ("job",)),
    _Intent("drive_apply", "drive_apply",
            lambda m: m.has(r"\bapply\s+(?:to|for)\s+(?P<ref>.+)$") and not m.has(r"\bcan\s+i\s+apply\b"),
            lambda m: _job_args(m, "apply"),
            ("job",)),
    _Intent("offer_respond", "offer_respond",
            lambda m: m.has(r"\b(accept|reject|decline)\b[^.?!]{0,40}\boffer\b"),
            lambda m: (lambda ref: ref if isinstance(ref, PlannerReply) else {
                "decision": extract_decision(m.text), "job": ref,
            })(m.job("offer")),
            ("decision",)),
    _Intent("offers_list", "offers_list",
            lambda m: m.has(r"\boffers?\b"),
            lambda m: {}),
    _Intent("training_register", "training_register",
            lambda m: m.has(r"\b(register|enrol+|sign\s+up|join)\b[^.?!]{0,40}\b(training|program(me)?|workshop|bootcamp)\b"),
            lambda m: {"program": _training_program(m)},
            ("program",)),
    _Intent("training_list", "training_list",
            lambda m: m.has(r"\b(training|workshops?|bootcamps?)\b"),
            lambda m: {"mine": True if m.has(r"\bmy\b") else None}),
    _Intent("market_job_mark_applied", "market_job_mark_applied",
            lambda m: m.has(r"\bmark\b[^.?!]{0,40}\bas\s+applied\b|\bi\s+(?:have\s+|'ve\s+|just\s+)?applied\b"),
            lambda m: _job_args(m, "applied"),
            ("job",)),
    _Intent("market_job_save", "market_job_save",
            lambda m: m.has(r"\b(save|bookmark|wish\s*-?\s*list)\b"),
            lambda m: _job_args(m, "save"),
            ("job",)),
    _Intent("resume_tailor_for_job", "resume_tailor_for_job",
            lambda m: m.has(r"\btailor\b[^.?!]{0,30}\b(resume|cv)\b"),
            lambda m: _job_args(m, "tailor"),
            ("job",)),
    _Intent("resume_score", "resume_score",
            lambda m: m.has(r"\b(score|rate|ats)\b[^.?!]{0,20}\b(resume|cv)\b|\b(resume|cv)\s+score\b"),
            lambda m: {}),
    _Intent("resume_list", "resume_list",
            lambda m: m.has(r"\b(my\s+resumes|(list|show)\b[^.?!]{0,10}\bresumes)\b"),
            lambda m: {}),
    _Intent("placement_stats", "placement_stats",
            lambda m: m.has(r"\bplacement\s+(stats|statistics|analytics|report|numbers)\b|\bhow\s+many\s+(students\s+)?(are\s+|got\s+)?placed\b"),
            lambda m: {}),
    _Intent("applicants_list", "applicants_list",
            lambda m: m.has(r"\b(applicants|candidates|applications)\s+(for|of|to)\s+(?P<ref>.+)$"),
            lambda m: _job_args(m, "applicants", status=extract_application_status(
                re.sub(r"\b(applicants|candidates|applications)\b", " ", m.text, flags=I))),
            ("job",)),
    _Intent("drive_close", "drive_close",
            lambda m: m.has(r"\bclose\b[^.?!]{0,30}\b(drive|job|posting)\b"),
            lambda m: _job_args(m, "close"),
            ("job",)),
    _Intent("drives_list", "drives_list",
            lambda m: m.has(r"\b(drives|my\s+postings|job\s+postings|active\s+jobs)\b"),
            lambda m: {"status": _drives_status(m)}),
    _Intent("jobs_search_campus", "jobs_search_campus",
            lambda m: m.has(r"\b(campus|placement)\s+(drives?|jobs?|openings?)\b|\beligible\s+(drives|jobs)\b|\bon[-\s]campus\b"),
            lambda m: (lambda args: {
                "query": args.query or None, "location": args.location,
                "eligibleOnly": True if m.has(r"\beligible\b") else None,
            })(extract_search_args(_CAMPUS_TRIGGER_RE.sub(" ", m.text)))),
    _Intent("jobs_search_market", "jobs_search_market",
            lambda m: m.has(r"\b(find|search|show|get|browse|look(ing)?\s+for|any)\b[^.?!]{0,25}\b(jobs?|internships?|openings?|roles?|positions?|vacanc(y|ies))\b"),
            lambda m: (lambda args: {
                "query": args.query or None, "jobType": args.job_type,
                "workType": args.work_type, "location": args.location,
            })(extract_search_args(m.text))),
    _Intent("job_feed_sync", "job_feed_sync",
            lambda m: m.has(r"\bsync\b[^.?!]{0,20}\b(job\s*feed|jobs|feed)\b"),
            lambda m: {}),
    _Intent("get_my_profile", "get_my_profile",
            lambda m: m.has(r"\b(my\s+profile|about\s+me|my\s+details|my\s+cgpa|who\s+am\s+i)\b"),
            lambda m: {}),
)

# Planner-required arguments per tool (the starred args of the intent table).
_PLANNER_REQUIRED: Dict[str, Tuple[str, ...]] = {}
for _intent in INTENTS:
    if _intent.tool and _intent.required:
        _PLANNER_REQUIRED.setdefault(_intent.tool, _intent.required)

_JOB_MODE_BY_TOOL = {
    "drive_apply": "apply",
    "application_withdraw": "withdraw",
    "offer_respond": "offer",
    "market_job_save": "save",
    "market_job_mark_applied": "applied",
    "resume_tailor_for_job": "tailor",
    "applicants_list": "applicants",
    "drive_close": "close",
    "job_details": "apply",
}


def _required_args(tool: str, spec: ToolSpec) -> List[str]:
    props = spec.properties
    ordered: List[str] = []
    for name in (*_PLANNER_REQUIRED.get(tool, ()), *spec.required):
        if name in props and name not in ordered:
            ordered.append(name)
    return ordered


def _missing(tool: str, args: Dict[str, Any], spec: ToolSpec) -> Optional[PlannerReply]:
    for arg in _required_args(tool, spec):
        if arg not in args:
            prompt = MISSING_ARG_PROMPTS.get(arg, f"I need the {arg} to do that.")
            return PlannerReply(prompt, kind="clarify", awaiting=AwaitingInput(tool, dict(args), arg, None))
    return None


def _finalize(intent: _Intent, raw_args: Dict[str, Any], manifest: Manifest) -> Outcome:
    spec = manifest.get(intent.tool or "")
    if spec is None:  # pragma: no cover - callers check the manifest first
        return PlannerReply(FALLBACK_UNKNOWN, kind="unknown")
    props = spec.properties
    args = {key: value for key, value in raw_args.items() if value is not None and value != "" and key in props}
    missing = _missing(spec.name, args, spec)
    return missing or PlannedCall(spec.name, args, intent.name)


def _first_intent(m: _Msg) -> Tuple[Optional[_Intent], Union[Dict[str, Any], PlannerReply, None]]:
    names = m.manifest.names
    for intent in INTENTS:
        if intent.tool is not None and intent.tool not in names:
            continue
        try:
            if not intent.matches(m):
                continue
            outcome = intent.build(m)
        except Exception:  # an extractor bug must never break the turn
            continue
        if outcome is None:
            continue
        return intent, outcome
    return None, None


def plan(
    text: str,
    *,
    role: str,
    manifest: Manifest,
    session_id: str,
    selected_job: Optional[dict] = None,
    ui_context: Optional[dict] = None,
    denied_mode: Optional[AgentMode] = None,
    actor_name: Optional[str] = None,
) -> Outcome:
    message = _Msg(
        text, role=role, manifest=manifest, session_id=session_id, selected_job=selected_job,
        ui_context=ui_context, actor_name=actor_name, denied_mode=denied_mode,
    )
    intent, outcome = _first_intent(message)
    if intent is not None:
        if isinstance(outcome, PlannerReply):
            return outcome
        return _finalize(intent, outcome, manifest)
    capabilities = capabilities_markdown(role, manifest)
    if denied_mode is not None and denied_mode in ROLE_DENIED_TEXT:
        return PlannerReply(ROLE_DENIED_TEXT[denied_mode] + "\n\n" + capabilities, kind="denied")
    return PlannerReply(FALLBACK_UNKNOWN + "\n\n" + capabilities, kind="unknown")


def _pick_candidate(text: str, candidates: List[dict]) -> Optional[dict]:
    reply = _normalize(text).strip(" .!?")
    if not reply:
        return None
    match = re.fullmatch(r"(?:option|number|no\.?|#)?\s*(\d{1,2})", reply, I)
    if match:
        index = int(match.group(1))
        return candidates[index - 1] if 1 <= index <= len(candidates) else None
    ordinal = re.fullmatch(r"(?:the\s+)?(first|second|third|fourth|fifth|sixth|1st|2nd|3rd|4th|5th|6th)(?:\s+one)?", reply, I)
    if ordinal:
        words = {"first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5, "sixth": 6}
        word = ordinal.group(1).lower()
        index = words.get(word) or int(re.match(r"\d+", word).group(0))
        return candidates[index - 1] if 1 <= index <= len(candidates) else None
    lowered = reply.lower()
    for candidate in candidates:
        if str(candidate.get("label", "")).strip().lower() == lowered:
            return candidate
    if len(lowered) >= 3:
        containing = [c for c in candidates if lowered in str(c.get("label", "")).lower()]
        if len(containing) == 1:
            return containing[0]
    return None


def _short_reply(text: str) -> Optional[str]:
    value = _normalize(text).strip(" .!?,;:\"'")
    return value if value and len(value) <= 60 else None


def _fill(arg: str, tool: str, m: _Msg) -> Union[str, int, PlannerReply, None]:
    if arg == "course":
        return extract_course(m.text, m.ui_context) or _short_reply(m.text)
    if arg in ("when", "from"):
        return extract_when(m.text) or _short_reply(m.text)
    if arg == "job":
        ref = resolve_job_ref(
            m.text, session_id=m.session_id, selected_job=m.selected_job, ui_context=m.ui_context,
            mode=_JOB_MODE_BY_TOOL.get(tool, "apply"),
        )
        if ref is not None:
            return ref
        if _JOB_MODE_BY_TOOL.get(tool) in ("save", "applied"):
            return None
        reply = _short_reply(m.text)
        return _clean_ref(reply) if reply else None
    if arg == "joinCode":
        code = extract_join_code(m.text)
        if code:
            return code
        reply = _short_reply(m.text)
        return reply.upper() if reply and re.fullmatch(r"[A-Za-z0-9]{6}", reply) else None
    if arg == "decision":
        return extract_decision(m.text)
    if arg == "status":
        if tool == "attendance_mark_manual":
            return extract_attendance_status(m.text)
        return extract_application_status(m.text) or _short_reply(m.text)
    if arg == "threshold":
        return extract_threshold(m.text)
    if arg == "durationMinutes":
        return extract_duration_minutes(m.text)
    return _short_reply(m.text)


def continue_awaiting(
    text: str,
    awaiting: AwaitingInput,
    *,
    manifest: Manifest,
    session_id: str,
    selected_job: Optional[dict] = None,
    ui_context: Optional[dict] = None,
) -> Optional[Outcome]:
    """Resume a clarification or an AMBIGUOUS choice; None = treat as a new request."""
    spec = manifest.get(awaiting.tool)
    if spec is None:
        return None
    message = _Msg(
        text, role=None, manifest=manifest, session_id=session_id,
        selected_job=selected_job, ui_context=ui_context,
    )
    reply = classify_reply(text)
    if reply == "negative":
        return PlannerReply(CANCELLED_TEXT, kind="cancelled")
    if reply == "affirm":
        return None  # "yes" is not a value; treat the message as a new request
    intent, _ = _first_intent(message)
    if intent is not None and intent.tool != awaiting.tool:
        return None

    if awaiting.candidates:
        candidate = _pick_candidate(text, awaiting.candidates)
        if candidate is None:
            return None
        return PlannedCall(awaiting.tool, {**awaiting.args, awaiting.arg: candidate["id"]}, "awaiting")

    value = _fill(awaiting.arg, awaiting.tool, message)
    if isinstance(value, PlannerReply):
        return value
    if value is None or value == "":
        return None
    args = {**awaiting.args, awaiting.arg: value}
    missing = _missing(awaiting.tool, args, spec)
    return missing or PlannedCall(awaiting.tool, args, "awaiting")


def _first_sentence(description: str) -> str:
    text = " ".join((description or "").split())
    if not text:
        return ""
    sentence = re.split(r"(?<=[.!?])\s+", text, maxsplit=1)[0]
    return sentence if len(sentence) <= 120 else sentence[:117].rstrip() + "…"


def capabilities_markdown(role: str, manifest: Manifest) -> str:
    bullets: List[str] = []
    for spec in manifest.tools:
        if spec.name == "open_panel":
            continue
        bullets.append(f"- {_first_sentence(spec.description) or humanize(spec.name)}")
        if len(bullets) >= 12:
            break
    phrases = [SPECIALIST_PHRASES[mode] for mode in specialist_modes(role) if mode in SPECIALIST_PHRASES]
    lines: List[str] = []
    if bullets:
        lines.append("Here's what I can help you with:")
        lines.extend(bullets)
    if phrases:
        if lines:
            lines.append("")
        lines.append("You can also ask for: " + "; ".join(phrases) + ".")
    if not lines:
        lines.append("I can answer questions about your campus account once my tools are available.")
    return "\n".join(lines)


__all__ = [
    "PlannedCall", "PlannerReply", "MISSING_ARG_PROMPTS", "plan", "continue_awaiting", "capabilities_markdown",
    "resolve_job_ref", "extract_when", "extract_from_when", "extract_duration_minutes", "extract_room",
    "extract_course", "extract_topic", "extract_within", "extract_days", "extract_threshold", "extract_join_code",
    "extract_attendance_status", "extract_application_status", "extract_decision", "extract_reason", "extract_date",
    "NOT_MENTIONED",
]
