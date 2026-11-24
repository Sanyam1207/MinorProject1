"""Deterministic intent routing.

Picking an agent is a control decision, not a content one: it has to be
instant, repeatable, free, and it must not fail when an API is rate limited or
down. So it is decided here in plain Python. Agents spend the LLM budget on
their own work -- writing interview questions, extracting a job description,
scoring a transcript -- not on deciding who should run.

Each agent declares a ``ROUTING_RULES`` describing how its own requests look.
The orchestrator only knows how to score and compare them, so adding an agent
means adding rules to that agent, never editing the router.

Scoring
-------
``strong`` patterns are phrases that mean the request on their own ("mock
interview", "find me jobs", "build my resume"). ``weak`` patterns are topic
words that merely hint ("jobs", "resume"). A strong hit outweighs any number
of weak ones, which is what keeps "I built a job board" -- one weak hit --
from being read as a request to go job hunting.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import List, Pattern, Sequence, Tuple

STRONG_WEIGHT = 10
WEAK_WEIGHT = 1


def _compile(patterns: Sequence[str]) -> List[Pattern[str]]:
    return [re.compile(pattern, re.IGNORECASE) for pattern in patterns]


@dataclass
class RoutingRules:
    """How one agent's requests look, as regular expressions.

    Patterns should be word-boundary anchored. Substring matching silently
    misfires -- "no" inside "Nokia", "ready" inside "already" -- and a router
    that misfires sends the user to the wrong agent.
    """

    strong: Sequence[str] = ()
    weak: Sequence[str] = ()
    veto: Sequence[str] = ()

    _strong: List[Pattern[str]] = field(init=False, repr=False, default_factory=list)
    _weak: List[Pattern[str]] = field(init=False, repr=False, default_factory=list)
    _veto: List[Pattern[str]] = field(init=False, repr=False, default_factory=list)

    def __post_init__(self) -> None:
        self._strong = _compile(self.strong)
        self._weak = _compile(self.weak)
        self._veto = _compile(self.veto)

    def score(self, text: str) -> Tuple[int, int]:
        """Return ``(total_score, strong_hits)`` for *text*.

        ``strong_hits`` is reported separately because switching a user out of
        an active workflow demands a strong match, while first-time routing can
        settle for weak evidence.
        """
        if not text:
            return 0, 0
        if any(pattern.search(text) for pattern in self._veto):
            return 0, 0
        strong = sum(1 for pattern in self._strong if pattern.search(text))
        weak = sum(1 for pattern in self._weak if pattern.search(text))
        return strong * STRONG_WEIGHT + weak * WEAK_WEIGHT, strong


# ---------------------------------------------------------------------------
# Narration vs instruction
#
# "I built a job board" and "find me a job" both mention jobs. The difference
# is who the sentence is about: a speaker describing their own work is not
# giving the assistant an instruction. This matters when deciding whether to
# pull someone out of an active workflow, where a wrong guess is expensive.
# ---------------------------------------------------------------------------

NARRATIVE_START_RE = re.compile(r"^\s*(i|we|my|our|mine|ours)\b", re.IGNORECASE)

# ...unless the first person is the one doing the asking.
DESIRE_RE = re.compile(
    r"^\s*(i\s*'?d\s+like|i\s+(want|need|wanna|would\s+like)|let'?s)\b",
    re.IGNORECASE,
)


def is_self_narration(text: str) -> bool:
    """True when the message opens with the speaker describing themselves."""
    if not text:
        return False
    return bool(NARRATIVE_START_RE.match(text)) and not DESIRE_RE.match(text)


# A URL almost always means "go and look at this careers page".
URL_PATTERN = r"https?://\S+"
