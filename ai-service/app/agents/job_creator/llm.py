"""LLM call for the Job Creation Agent, through the shared Gemini client.

Never raises: a failed call returns a short fallback sentence, which the agent
shows instead of a draft update (the deterministic validator still decides
what is complete and nothing can be posted without the TPO's explicit "yes").
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List

from app.llm import gemini

log = logging.getLogger("job_creator.llm")

_FALLBACK = "I'm having trouble processing that right now. Could you please try again?"


async def call_gemini_chat(
    system_prompt: str,
    history: List[Dict[str, Any]],
    user_turn: str,
) -> str:
    """Non-streaming call for job extraction and clarification replies (≤ 45 s in total)."""
    text = await gemini.generate_text(
        contents=list(history) + [gemini.user_turn(user_turn)],
        system=system_prompt,
        temperature=0.4,
        max_output_tokens=2048,
        timeout=30,
        max_retries=2,
    )
    return text if text is not None else _FALLBACK
