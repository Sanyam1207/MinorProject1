"""Gemini client for the AI Interviewer Agent.

Self-contained inside the interviewer package, same as ``job_creator.llm``.
Every call goes through ``settings.GEMINI_MODEL`` so the model is configured
in exactly one place (the ``GEMINI_MODEL`` environment variable).

Two entry points:

``call_gemini_json``  -- structured output (question generation, JD
                         extraction, report scoring). Returns a parsed dict.
``call_gemini_text``  -- plain prose, used for short conversational lines.

Both retry on HTTP 429 honouring the ``retryDelay`` Gemini sends back, and
both fail soft: a failed call returns ``None`` so the caller decides what the
user sees rather than an exception escaping mid-interview.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any, Dict, List, Optional

import httpx

from app.config import settings

log = logging.getLogger("interviewer.llm")

_ENDPOINT = (
    f"https://generativelanguage.googleapis.com/v1beta/models/"
    f"{settings.GEMINI_MODEL}:generateContent"
    f"?key={settings.GEMINI_API_KEY}"
)

_MAX_RETRIES = 2


def _retry_delay_seconds(response: httpx.Response, default: float = 5.0) -> float:
    """Pull Gemini's suggested retryDelay out of a 429 body, if present."""
    try:
        details = response.json().get("error", {}).get("details", [])
        for detail in details:
            raw = detail.get("retryDelay", "")
            if not raw:
                continue
            match = re.match(r"(\d+(?:\.\d+)?)\s*(s|ms)?", raw)
            if match:
                value = float(match.group(1))
                seconds = value / 1000 if match.group(2) == "ms" else value
                return min(seconds + 1.0, 30.0)
    except Exception:
        pass
    return default


async def _post(payload: Dict[str, Any], timeout: float) -> Optional[str]:
    """POST *payload* to Gemini and return the raw text part, or None."""
    for attempt in range(_MAX_RETRIES + 1):
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.post(_ENDPOINT, json=payload)

                if response.status_code == 429 and attempt < _MAX_RETRIES:
                    wait = _retry_delay_seconds(response)
                    log.warning(
                        "Gemini rate limited (429) -- attempt %d/%d, waiting %.1fs",
                        attempt + 1, _MAX_RETRIES, wait,
                    )
                    await asyncio.sleep(wait)
                    continue

                if response.status_code != 200:
                    log.warning(
                        "Gemini call failed: HTTP %s -- %s",
                        response.status_code, response.text[:300],
                    )
                    return None

                return response.json()["candidates"][0]["content"]["parts"][0]["text"]

        except httpx.TimeoutException:
            log.warning("Gemini call timed out (attempt %d/%d)", attempt + 1, _MAX_RETRIES + 1)
            if attempt < _MAX_RETRIES:
                await asyncio.sleep(2.0)
                continue
            return None
        except (KeyError, IndexError, TypeError) as exc:
            log.error("Unexpected Gemini response shape: %s", exc)
            return None
        except Exception:
            log.exception("Gemini call failed unexpectedly")
            return None

    return None


def _strip_fences(text: str) -> str:
    """Remove ```json fences the model may add despite the JSON mime type."""
    cleaned = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.MULTILINE)
    return cleaned.strip()


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
    contents = list(history or []) + [{"role": "user", "parts": [{"text": user_turn}]}]
    payload = {
        "system_instruction": {"parts": [{"text": system_prompt}]},
        "contents": contents,
        "generationConfig": {
            "temperature": temperature,
            "maxOutputTokens": max_output_tokens,
            "response_mime_type": "application/json",
        },
    }

    raw = await _post(payload, timeout)
    if raw is None:
        return None

    try:
        parsed = json.loads(_strip_fences(raw))
    except json.JSONDecodeError:
        log.warning("Gemini returned non-JSON content: %r", raw[:300])
        return None

    if not isinstance(parsed, dict):
        log.warning("Gemini returned a non-object JSON value: %r", parsed)
        return None
    return parsed


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
    contents = list(history or []) + [{"role": "user", "parts": [{"text": user_turn}]}]
    payload = {
        "system_instruction": {"parts": [{"text": system_prompt}]},
        "contents": contents,
        "generationConfig": {
            "temperature": temperature,
            "maxOutputTokens": max_output_tokens,
        },
    }

    raw = await _post(payload, timeout)
    return raw.strip() if raw else None
