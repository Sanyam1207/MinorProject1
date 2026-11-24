"""LLM client utilities for the PR Outreach Agent.

Kept self-contained inside the pr_outreach package to avoid coupling
with other agents.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any, Dict, List

import httpx

from app.config import settings

log = logging.getLogger("pr_outreach.llm")

_SYNC_ENDPOINT = (
    f"https://generativelanguage.googleapis.com/v1beta/models/"
    f"{settings.GEMINI_MODEL}:generateContent"
    f"?key={settings.GEMINI_API_KEY}"
)

_FALLBACK = "I'm having trouble processing that right now. Could you please try again?"


async def call_gemini_chat(
    system_prompt: str,
    history: List[Dict[str, Any]],
    user_turn: str,
) -> str:
    """Non-streaming call to Gemini for conversational email drafting."""
    contents = list(history) + [{"role": "user", "parts": [{"text": user_turn}]}]
    payload = {
        "system_instruction": {"parts": [{"text": system_prompt}]},
        "contents": contents,
        "generationConfig": {
            "temperature": 0.5,
            "maxOutputTokens": 2048,
        },
    }

    max_retries = 3
    for attempt in range(max_retries + 1):
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                resp = await client.post(_SYNC_ENDPOINT, json=payload)

                if resp.status_code == 429:
                    if attempt < max_retries:
                        wait_sec = 5.0
                        try:
                            body = resp.json()
                            details = body.get("error", {}).get("details", [])
                            for detail in details:
                                rd = detail.get("retryDelay", "")
                                if rd:
                                    m = re.match(r"(\d+(?:\.\d+)?)\s*(s|ms)?", rd)
                                    if m:
                                        val = float(m.group(1))
                                        unit = m.group(2) or "s"
                                        wait_sec = val / 1000 if unit == "ms" else val
                                        wait_sec = min(wait_sec + 2, 65.0)
                                    break
                        except Exception:
                            pass
                        log.warning(
                            "Gemini rate limited (429) — attempt %d/%d, waiting %.1fs",
                            attempt + 1, max_retries, wait_sec,
                        )
                        await asyncio.sleep(wait_sec)
                        continue
                    else:
                        log.warning("Gemini chat failed with 429 after %d retries: %s", max_retries, resp.text)
                        return _FALLBACK

                if resp.status_code != 200:
                    log.warning("Gemini chat failed with %d: %s", resp.status_code, resp.text)
                    return _FALLBACK

                try:
                    data = resp.json()
                    text = data["candidates"][0]["content"]["parts"][0]["text"]
                    return text.strip()
                except Exception as e:
                    log.error("Failed to parse Gemini response: %s | Raw: %s", e, resp.text)
                    return _FALLBACK

        except httpx.TimeoutException:
            log.warning("Gemini chat timed out (attempt %d/%d)", attempt + 1, max_retries)
            if attempt < max_retries:
                await asyncio.sleep(3.0)
                continue
            return _FALLBACK
        except Exception:
            log.exception("Gemini chat call failed unexpectedly")
            return _FALLBACK

    return _FALLBACK
