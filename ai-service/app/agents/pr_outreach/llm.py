"""LLM call for the PR Outreach Agent, through the shared Gemini client."""

from __future__ import annotations

import logging
from typing import Any, Dict, List

from app.llm import gemini

log = logging.getLogger("pr_outreach.llm")

_FALLBACK = "I'm having trouble processing that right now. Could you please try again?"


async def call_gemini_chat(
    system_prompt: str,
    history: List[Dict[str, Any]],
    user_turn: str,
) -> str:
    """Non-streaming call to Gemini for conversational email drafting. Never raises."""
    text = await gemini.generate_text(
        contents=list(history) + [gemini.user_turn(user_turn)],
        system=system_prompt,
        temperature=0.5,
        max_output_tokens=2048,
        timeout=30,
        max_retries=2,
    )
    return text if text is not None else _FALLBACK
