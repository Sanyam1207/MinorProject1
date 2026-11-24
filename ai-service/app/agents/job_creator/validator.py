"""Deterministic validation helpers for the Job Creation Agent.

All validation here uses pure Python logic — no LLM calls.
The LLM is responsible only for natural-language understanding; this
module is responsible for deciding whether data is actually valid.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone, timedelta
from typing import List, Optional, Tuple

# ── Mandatory fields ─────────────────────────────────────────────────────────
MANDATORY_FIELDS = ["company_name", "job_role", "job_description", "app_deadline"]

# Human-readable labels used in prompts
FIELD_LABELS = {
    "company_name": "company name",
    "job_role": "job role / title",
    "job_description": "job description",
    "app_deadline": "application deadline",
}

# ── Confirmation intent keywords ─────────────────────────────────────────────
_CONFIRM_PHRASES = [
    "yes", "confirm", "confirm it", "post it", "go ahead", "do it",
    "proceed", "sure", "absolutely", "yep", "yeah", "yup", "affirmative",
    "post the job", "post now", "submit", "finalize", "finalise",
]

# ── Cancellation intent keywords ─────────────────────────────────────────────
_CANCEL_PHRASES = [
    "no", "cancel", "don't post", "dont post", "not yet", "stop",
    "abort", "nope", "nah", "negative", "hold on", "wait", "never mind",
    "nevermind",
]

# IST offset (UTC+5:30)
_IST = timezone(timedelta(hours=5, minutes=30))


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def get_missing_required_fields(job) -> List[str]:
    """Return names of mandatory fields that are absent/empty in *job*.

    Parameters
    ----------
    job: JobData instance.
    """
    missing = []
    for f in MANDATORY_FIELDS:
        val = getattr(job, f, "")
        if not val or (isinstance(val, str) and not val.strip()):
            missing.append(f)
    return missing


def validate_branches(
    requested: List[str],
    available: List[str],
) -> Tuple[List[str], List[str]]:
    """Check *requested* branches against *available*.

    Returns
    -------
    (valid, invalid):
        valid   — branches from *requested* that exist in *available* (case-insensitive).
        invalid — branches that were requested but do not exist in *available*.
    """
    available_lower = {b.strip().lower(): b for b in available}
    valid: List[str] = []
    invalid: List[str] = []
    for branch in requested:
        key = branch.strip().lower()
        if key in available_lower:
            valid.append(available_lower[key])   # canonical capitalisation
        else:
            invalid.append(branch)
    return valid, invalid


def parse_and_validate_deadline(
    raw: str,
    now_iso: Optional[str] = None,
) -> Tuple[Optional[str], Optional[str]]:
    """Try to parse *raw* into an ISO 8601 deadline string.

    Handles:
    - ISO 8601 strings (``2026-08-30T17:00:00+05:30``)
    - ``YYYY-MM-DD`` (assumes 23:59:59 IST)
    - ``DD/MM/YYYY`` and ``MM/DD/YYYY``
    - Plain date strings such as ``30 August 2026``

    Returns
    -------
    (iso_str, error):
        On success: (normalized ISO string, None)
        On failure: (None, human-readable error message)
    """
    if not raw or not raw.strip():
        return None, "No deadline value provided."

    raw = raw.strip()

    # --- Already a well-formed ISO datetime? ---------------------------------
    parsed = _try_iso(raw)
    if parsed:
        return _finalize(parsed, raw)

    # --- ISO date only: YYYY-MM-DD -------------------------------------------
    m = re.fullmatch(r"(\d{4})-(\d{1,2})-(\d{1,2})", raw)
    if m:
        try:
            parsed = datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)),
                              23, 59, 59, tzinfo=_IST)
            return _finalize(parsed, raw)
        except ValueError:
            pass

    # --- DD/MM/YYYY or MM/DD/YYYY -------------------------------------------
    m = re.fullmatch(r"(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})", raw)
    if m:
        a, b, yr = int(m.group(1)), int(m.group(2)), int(m.group(3))
        for day, mon in [(a, b), (b, a)]:
            try:
                parsed = datetime(yr, mon, day, 23, 59, 59, tzinfo=_IST)
                return _finalize(parsed, raw)
            except ValueError:
                continue

    # --- Natural language: "30 August 2026" / "August 30 2026" etc. ---------
    parsed = _try_natural(raw)
    if parsed:
        return _finalize(parsed, raw)

    return None, (
        f"I couldn't parse '{raw}' as a date. "
        "Please provide a date like '30 August 2026' or '2026-08-30T17:00:00+05:30'."
    )


def is_deadline_expired(deadline_iso: str, now_iso: Optional[str] = None) -> bool:
    """Return True if *deadline_iso* is in the past relative to *now_iso*."""
    try:
        deadline_dt = datetime.fromisoformat(deadline_iso)
        if now_iso:
            now_dt = datetime.fromisoformat(now_iso)
        else:
            now_dt = datetime.now(_IST)
        # Make both timezone-aware if either is naive
        if deadline_dt.tzinfo is None:
            deadline_dt = deadline_dt.replace(tzinfo=_IST)
        if now_dt.tzinfo is None:
            now_dt = now_dt.replace(tzinfo=_IST)
        return deadline_dt < now_dt
    except (ValueError, TypeError):
        return False


def is_confirmation_intent(text: str) -> bool:
    """Return True if *text* looks like a 'yes, post it' confirmation."""
    t = text.strip().lower()
    # Must be a short message to avoid interpreting long paragraphs
    if len(t) > 80:
        return False
    return any(phrase in t for phrase in _CONFIRM_PHRASES)


def is_cancellation_intent(text: str) -> bool:
    """Return True if *text* looks like a 'no, don't post' cancellation."""
    t = text.strip().lower()
    if len(t) > 80:
        return False
    return any(phrase in t for phrase in _CANCEL_PHRASES)


def friendly_missing(missing_fields: List[str]) -> str:
    """Return a comma-joined human-readable list of missing field labels."""
    return ", ".join(FIELD_LABELS.get(f, f.replace("_", " ")) for f in missing_fields)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

_MONTH_NAMES = {
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6,
    "july": 7, "august": 8, "september": 9, "october": 10, "november": 11, "december": 12,
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}


def _try_iso(raw: str) -> Optional[datetime]:
    try:
        return datetime.fromisoformat(raw)
    except ValueError:
        return None


def _try_natural(raw: str) -> Optional[datetime]:
    """Try common natural-language date patterns."""
    lower = raw.lower()
    # Pattern: "30 august 2026" or "30 aug 2026"
    m = re.search(r"(\d{1,2})\s+([a-z]+)\s+(\d{4})", lower)
    if m:
        day, mon_str, yr = int(m.group(1)), m.group(2), int(m.group(3))
        mon = _MONTH_NAMES.get(mon_str)
        if mon:
            # Check for optional time
            t = _extract_time(raw)
            try:
                return datetime(yr, mon, day, t[0], t[1], 0, tzinfo=_IST)
            except ValueError:
                pass

    # Pattern: "august 30, 2026" or "august 30 2026"
    m = re.search(r"([a-z]+)\s+(\d{1,2})[,\s]+(\d{4})", lower)
    if m:
        mon_str, day, yr = m.group(1), int(m.group(2)), int(m.group(3))
        mon = _MONTH_NAMES.get(mon_str)
        if mon:
            t = _extract_time(raw)
            try:
                return datetime(yr, mon, day, t[0], t[1], 0, tzinfo=_IST)
            except ValueError:
                pass

    return None


def _extract_time(text: str) -> Tuple[int, int]:
    """Extract HH:MM from *text* if present, else return (23, 59)."""
    m = re.search(r"(\d{1,2}):(\d{2})\s*(am|pm)?", text.lower())
    if m:
        h, minute = int(m.group(1)), int(m.group(2))
        ampm = m.group(3)
        if ampm == "pm" and h != 12:
            h += 12
        elif ampm == "am" and h == 12:
            h = 0
        return h, minute

    # "5 PM" / "17:00" without colon
    m = re.search(r"(\d{1,2})\s*(am|pm)", text.lower())
    if m:
        h = int(m.group(1))
        if m.group(2) == "pm" and h != 12:
            h += 12
        elif m.group(2) == "am" and h == 12:
            h = 0
        return h, 0

    return 23, 59


def _finalize(dt: datetime, raw: str) -> Tuple[Optional[str], Optional[str]]:
    """Ensure datetime is timezone-aware, then return as ISO string."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=_IST)
    return dt.isoformat(), None
