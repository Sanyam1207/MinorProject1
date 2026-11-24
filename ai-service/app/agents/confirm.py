"""Deterministic yes/no classification for confirmation replies.

Used wherever a user's short reply approves or rejects a pending side effect
(copilot confirmations, job-creation "post it"). Matching is whole-message and
word-boundary based -- never substrings -- so "make sure the cgpa is 7",
"yesterday", "Nokia" or "yes but at 11am" are never read as a "yes".
"""

from __future__ import annotations

import re
from functools import lru_cache
from typing import Iterable, Literal, Optional, Pattern, Tuple

Reply = Literal["affirm", "negative"]

# Regex fragments (single spaces inside an entry mean "one or more spaces").
_AFFIRM: Tuple[str, ...] = (
    "yes", "yeah", "yep", "yup", "ya", "sure", "ok", "okay", "k", "confirm", "confirmed",
    "go ahead", "do it", "proceed", "please do", "absolutely", "correct", "right",
    "sounds good", "looks good", "approve", "approved", "go for it",
)
_NEGATIVE: Tuple[str, ...] = (
    "no", "nope", "nah", "cancel", "cancel it", "stop", "abort", "don't", "dont", "do not",
    r"never\s*mind", "not now", "forget it", "leave it", "skip it", "no thanks",
)
_FILLER: Tuple[str, ...] = ("please", "pls", "thanks", "thank you", "it", "that", "this", "now")


def normalize_reply(text: str) -> str:
    """Lower-case, curly apostrophes straightened, punctuation to spaces, spaces collapsed."""
    lowered = (text or "").lower().replace("’", "'").replace("‘", "'")
    cleaned = re.sub(r"[^a-z0-9' ]", " ", lowered)
    return re.sub(r"\s+", " ", cleaned).strip()


def _fragment(entry: str) -> str:
    """Built-in entries: spaces become ``\\s+``; existing regex syntax is kept."""
    return r"\s+".join(entry.split(" "))


def _phrase(entry: str) -> str:
    """Caller-supplied phrases: every token escaped, joined with ``\\s+``."""
    tokens = [re.escape(token) for token in normalize_reply(entry).split(" ") if token]
    return r"\s+".join(tokens)


def _alternation(fragments: Iterable[str]) -> str:
    unique = sorted({f for f in fragments if f}, key=len, reverse=True)
    return "(?:" + "|".join(unique) + ")"


@lru_cache(maxsize=64)
def _patterns(extra_affirmative: Tuple[str, ...], extra_negative: Tuple[str, ...]) -> Tuple[Pattern[str], Pattern[str]]:
    filler = _alternation(_fragment(f) for f in _FILLER)
    affirm = _alternation([*(_fragment(a) for a in _AFFIRM), *(_phrase(a) for a in extra_affirmative)])
    negative = _alternation([*(_fragment(n) for n in _NEGATIVE), *(_phrase(n) for n in extra_negative)])
    affirm_re = re.compile(rf"^{affirm}(?:\s+(?:{affirm}|{filler}))*$")
    negative_re = re.compile(rf"^{negative}(?:\s+(?:{negative}|{filler}))*$")
    return affirm_re, negative_re


def classify_reply(
    text: str,
    *,
    extra_affirmative: Iterable[str] = (),
    extra_negative: Iterable[str] = (),
    max_len: int = 60,
) -> Optional[Reply]:
    """``"affirm"``, ``"negative"`` or None (anything else, including long messages)."""
    normalized = normalize_reply(text)
    if not normalized or len(normalized) > max_len:
        return None
    affirm_re, negative_re = _patterns(tuple(extra_affirmative), tuple(extra_negative))
    if affirm_re.fullmatch(normalized):
        return "affirm"
    if negative_re.fullmatch(normalized):
        return "negative"
    return None
