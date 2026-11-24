"""LLM call for the Gap Analysis Agent, through the shared Gemini client."""

from __future__ import annotations

import logging
from typing import Any, Dict, List

from app.llm import gemini

log = logging.getLogger("gap_analysis.llm")

_FALLBACK = (
    "I'm having trouble processing that right now. Could you please try again?"
)


async def call_gemini_chat(
    system_prompt: str,
    history: List[Dict[str, Any]],
    user_turn: str,
) -> str:
    """Non-streaming call for gap analysis and conversation (detailed tables). Never raises."""
    text = await gemini.generate_text(
        contents=list(history) + [gemini.user_turn(user_turn)],
        system=system_prompt,
        temperature=0.4,
        max_output_tokens=4096,
        timeout=30,
    )
    return text if text is not None else _FALLBACK
