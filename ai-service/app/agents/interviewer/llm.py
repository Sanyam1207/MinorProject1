"""Gemini calls for the AI Interviewer (and learning recommendations).

Thin wrappers over the shared client (``app/llm/gemini.py``) that keep the
original signatures:

``call_gemini_json``  -- structured output (question generation, JD
                         extraction, report scoring). Returns a parsed dict.
``call_gemini_text``  -- plain prose, used for short conversational lines.

Both fail soft: a failed call returns ``None`` so the caller decides what the
user sees rather than an exception escaping mid-interview. Rate limits and
transient errors are retried by the shared client (2 retries).
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from app.llm import gemini

log = logging.getLogger("interviewer.llm")

_MAX_RETRIES = 2


async def call_gemini_json(
    system_prompt: str,
    user_turn: str,
    *,
    history: Optional[List[Dict[str, Any]]] = None,
    temperature: float = 0.6,
    max_output_tokens: int = 1024,
    timeout: float = 20.0,
) -> Optional[Dict[str, Any]]:
    """Ask Gemini for a single JSON object. Returns the parsed dict or None."""
    return await gemini.generate_json(
        contents=list(history or []) + [gemini.user_turn(user_turn)],
        system=system_prompt,
        temperature=temperature,
        max_output_tokens=max_output_tokens,
        timeout=timeout,
        max_retries=_MAX_RETRIES,
    )


async def call_gemini_text(
    system_prompt: str,
    user_turn: str,
    *,
    history: Optional[List[Dict[str, Any]]] = None,
    temperature: float = 0.6,
    max_output_tokens: int = 256,
    timeout: float = 15.0,
) -> Optional[str]:
    """Ask Gemini for a short piece of prose. Returns the text or None."""
    return await gemini.generate_text(
        contents=list(history or []) + [gemini.user_turn(user_turn)],
        system=system_prompt,
        temperature=temperature,
        max_output_tokens=max_output_tokens,
        timeout=timeout,
        max_retries=_MAX_RETRIES,
    )
