"""LaTeX streaming from Gemini for the Resume Generator Agent.

All calls go through the shared client (``app/llm/gemini.py``): the API key
travels in a header, never in a URL.
"""

from __future__ import annotations

import logging
from typing import Any, AsyncIterator, Dict, List, Tuple, Optional

from app.llm import gemini

log = logging.getLogger("resume_agent.latex")

_CHAT_FALLBACK = "I'm having trouble processing that right now. Could you please try again?"


# ---------------------------------------------------------------------------
# Streaming LaTeX generation / editing
# ---------------------------------------------------------------------------


async def stream_gemini_text(
    system_prompt: str,
    history: List[Dict[str, Any]],
    user_turn: str,
) -> AsyncIterator[str]:
    """Stream raw text chunks from Gemini.

    Parameters
    ----------
    system_prompt:  The system instruction for this phase.
    history:        Prior conversation turns (list of role/parts dicts).
    user_turn:      The new user message to append.

    Yields raw text chunks as they arrive over the SSE stream; on failure an
    inline ``[LaTeX generation ...]`` marker (as before).
    """
    contents = list(history) + [gemini.user_turn(user_turn)]
    try:
        async for chunk in gemini.stream_text(
            contents=contents,
            system=system_prompt,
            generation_config={"temperature": 0.3, "maxOutputTokens": 8192},
            timeout=60,
        ):
            if chunk:
                yield chunk
    except gemini.GeminiNotConfigured:
        log.warning("Gemini is not configured; cannot generate LaTeX")
        yield "\n[LaTeX generation error: the AI model is not configured]\n"
    except gemini.GeminiError as exc:
        if exc.reason in ("timeout", "deadline"):
            log.error("Gemini SSE timed out")
            yield "\n[LaTeX generation timed out]\n"
        elif exc.status:
            log.warning("Gemini SSE returned %s", exc.status)
            yield f"\n[LaTeX generation error: HTTP {exc.status}]\n"
        else:
            log.warning("Gemini SSE failed: %s", exc)
            yield f"\n[LaTeX generation error: {exc.reason}]\n"


# ---------------------------------------------------------------------------
# Non-streaming chat (used during information collection)
# ---------------------------------------------------------------------------


async def stream_and_extract_json(
    system_prompt: str,
    history: List[Dict[str, Any]],
    user_turn: str,
) -> AsyncIterator[Tuple[str, Optional[str]]]:
    """
    Yields (text_chunk, None) to stream conversational text in real-time,
    hiding any ```json ... ``` blocks.
    Once the stream ends, it yields (full_reply, json_content) as the final item.
    """
    buffer = ""
    in_json = False
    json_content = ""
    full_reply = ""

    async for chunk in stream_gemini_text(system_prompt, history, user_turn):
        full_reply += chunk
        buffer += chunk

        while True:
            if not in_json:
                idx = buffer.find("```json")
                if idx != -1:
                    text_before = buffer[:idx]
                    if text_before:
                        yield text_before, None
                    in_json = True
                    buffer = buffer[idx + 7:]
                else:
                    if len(buffer) > 7:
                        yield buffer[:-7], None
                        buffer = buffer[-7:]
                    break
            else:
                idx = buffer.find("```")
                if idx != -1:
                    json_content += buffer[:idx]
                    in_json = False
                    buffer = buffer[idx + 3:]
                else:
                    if len(buffer) > 3:
                        json_content += buffer[:-3]
                        buffer = buffer[-3:]
                    break

    if not in_json and buffer:
        yield buffer, None
    elif in_json and buffer:
        json_content += buffer

    yield full_reply, json_content.strip()


async def call_gemini_chat(
    system_prompt: str,
    history: List[Dict[str, Any]],
    user_turn: str,
) -> str:
    """Single non-streaming call to Gemini for conversational replies.

    Returns the complete response text, or a short fallback sentence.
    """
    text = await gemini.generate_text(
        contents=list(history) + [gemini.user_turn(user_turn)],
        system=system_prompt,
        temperature=0.4,
        max_output_tokens=512,
        timeout=20,
    )
    return text if text is not None else _CHAT_FALLBACK
