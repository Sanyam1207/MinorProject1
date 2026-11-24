"""LaTeX streaming from Gemini for the Resume Generator Agent.

Uses the same SSE streaming pattern as ``job_finder.py`` — raw ``httpx``
against the ``streamGenerateContent?alt=sse`` endpoint.
"""

from __future__ import annotations

import json
import logging
from typing import Any, AsyncIterator, Dict, List, Tuple, Optional

import httpx

from app.config import settings

log = logging.getLogger("resume_agent.latex")

_SSE_ENDPOINT = (
    f"https://generativelanguage.googleapis.com/v1beta/models/"
    f"{settings.GEMINI_MODEL}:streamGenerateContent"
    f"?key={settings.GEMINI_API_KEY}&alt=sse"
)

# Non-streaming endpoint (used for the conversational collection phase)
_SYNC_ENDPOINT = (
    f"https://generativelanguage.googleapis.com/v1beta/models/"
    f"{settings.GEMINI_MODEL}:generateContent"
    f"?key={settings.GEMINI_API_KEY}"
)


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

    Yields raw text chunks as they arrive over the SSE stream.
    """
    contents = list(history) + [{"role": "user", "parts": [{"text": user_turn}]}]
    payload = {
        "system_instruction": {"parts": [{"text": system_prompt}]},
        "contents": contents,
        "generationConfig": {
            "temperature": 0.3,
            "maxOutputTokens": 8192,
        },
    }

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            async with client.stream("POST", _SSE_ENDPOINT, json=payload) as resp:
                if resp.status_code != 200:
                    body = await resp.aread()
                    log.warning(
                        "Gemini SSE returned %d: %s", resp.status_code, body[:200]
                    )
                    yield f"\n[LaTeX generation error: HTTP {resp.status_code}]\n"
                    return

                async for line in resp.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    json_str = line[6:].strip()
                    if not json_str or json_str == "[DONE]":
                        continue
                    try:
                        data = json.loads(json_str)
                        chunk = (
                            data["candidates"][0]["content"]["parts"][0]["text"]
                        )
                        if chunk:
                            yield chunk
                    except (KeyError, IndexError, json.JSONDecodeError):
                        pass

    except httpx.TimeoutException:
        log.error("Gemini SSE timed out")
        yield "\n[LaTeX generation timed out]\n"
    except Exception as exc:
        log.exception("Gemini SSE error")
        yield f"\n[LaTeX generation error: {exc}]\n"


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

    Returns the complete response text.
    """
    contents = list(history) + [{"role": "user", "parts": [{"text": user_turn}]}]
    payload = {
        "system_instruction": {"parts": [{"text": system_prompt}]},
        "contents": contents,
        "generationConfig": {
            "temperature": 0.4,
            "maxOutputTokens": 512,
        },
    }

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(_SYNC_ENDPOINT, json=payload)
            if resp.status_code != 200:
                log.warning("Gemini chat failed with %d: %s", resp.status_code, resp.text)
                return "I'm having trouble processing that right now. Could you please try again?"
            
            try:
                data = resp.json()
                text = data["candidates"][0]["content"]["parts"][0]["text"]
                return text.strip()
            except Exception as e:
                log.error("Failed to parse Gemini response: %s | Raw response: %s", e, resp.text)
                return "I'm having trouble processing that right now. Could you please try again?"
    except httpx.TimeoutException:
        log.warning("Gemini chat timed out")
        return "I'm having trouble processing that right now. Could you please try again?"
    except Exception as exc:
        log.exception("Gemini chat call failed unexpectedly")
        return "I'm having trouble processing that right now. Could you please try again?"
