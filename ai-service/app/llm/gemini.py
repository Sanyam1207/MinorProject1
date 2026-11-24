"""The one Gemini REST client every agent uses.

* Authentication travels ONLY in the ``x-goog-api-key`` request header. URLs
  never carry a credential (``model_url`` builds them; the single query
  parameter ever used is ``alt=sse`` for streaming).
* Settings (model, credential, base URL, timeouts, retries) are read at call
  time, so tests can monkeypatch ``settings`` and a key rotation needs no
  restart of anything but the process.
* httpx request logging is silenced at import (httpx logs every URL at INFO).
* ``_TRANSPORT`` (an ``httpx`` transport, e.g. ``httpx.MockTransport``) and
  ``_sleep`` (the backoff sleep) are module globals so tests run offline and
  instantly.

``generate`` raises ``GeminiError``; ``generate_text`` / ``generate_json``
never raise (they return ``None``) so callers keep their deterministic
fallbacks; ``stream_text`` is an async generator that raises ``GeminiError``
when iterated.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx

from app.config import settings

log = logging.getLogger("llm.gemini")

for _name in ("httpx", "httpcore"):
    logging.getLogger(_name).setLevel(logging.WARNING)

API_VERSION = "v1beta"
BLOCK_FINISH_REASONS = {"SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"}
RETRYABLE_STATUS = {500, 502, 503, 504}
MAX_RATE_LIMIT_WAIT = 20.0
DEFAULT_RATE_LIMIT_WAIT = 2.0

# Test seams.
_TRANSPORT: Optional[httpx.AsyncBaseTransport] = None
_sleep = asyncio.sleep


class GeminiError(Exception):
    """A Gemini call failed. ``reason`` is one of http | timeout | network | parse | deadline | not_configured."""

    def __init__(self, message: str, *, status: Optional[int] = None, reason: str = "http") -> None:
        super().__init__(message)
        self.status = status
        self.reason = reason


class GeminiNotConfigured(GeminiError):
    """Raised before any HTTP call when no API credential is configured."""

    def __init__(self, message: str = "Gemini is not configured (GEMINI_API_KEY is empty).") -> None:
        super().__init__(message, status=None, reason="not_configured")


@dataclass(frozen=True)
class FunctionCall:
    name: str
    args: dict
    id: Optional[str] = None


@dataclass
class GeminiResponse:
    raw: dict
    text: str
    function_calls: List[FunctionCall]
    content: Optional[dict]
    finish_reason: Optional[str]
    block_reason: Optional[str]
    blocked: bool
    usage: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def _resolve_secret(api_key: Optional[str]) -> str:
    value = settings.GEMINI_API_KEY if api_key is None else api_key
    return value.strip() if isinstance(value, str) else ""


def is_configured(api_key: Optional[str] = None) -> bool:
    """True when a Gemini credential is available (argument, else settings)."""
    return bool(_resolve_secret(api_key))


def model_url(model: str, method: str) -> str:
    """``{base}/v1beta/models/{model}:{method}`` -- never carries a credential."""
    base = (settings.GEMINI_BASE_URL or "https://generativelanguage.googleapis.com").rstrip("/")
    name = (model or settings.GEMINI_MODEL or "").strip()
    if name.startswith("models/"):
        name = name[len("models/"):]
    return f"{base}/{API_VERSION}/models/{name}:{method}"


def auth_headers(api_key: str) -> Dict[str, str]:
    return {"x-goog-api-key": api_key, "Content-Type": "application/json"}


def user_turn(text: str) -> dict:
    return {"role": "user", "parts": [{"text": text}]}


def _build_body(
    contents: List[dict],
    system: Optional[str],
    tools: Optional[List[dict]],
    tool_config: Optional[dict],
    generation_config: Optional[dict],
) -> dict:
    body: Dict[str, Any] = {"contents": contents}
    if system:
        body["systemInstruction"] = {"parts": [{"text": system}]}
    if tools:
        body["tools"] = tools
    if tool_config:
        body["toolConfig"] = tool_config
    if generation_config:
        body["generationConfig"] = generation_config
    return body


def _parse_duration(value: Any) -> Optional[float]:
    """``"12s"`` / ``"1.5s"`` / ``"500ms"`` / ``"3"`` -> seconds."""
    if value is None:
        return None
    match = re.match(r"^\s*(\d+(?:\.\d+)?)\s*(ms|s)?\s*$", str(value))
    if not match:
        return None
    number = float(match.group(1))
    return number / 1000.0 if match.group(2) == "ms" else number


def _rate_limit_wait(response: httpx.Response) -> float:
    wait: Optional[float] = None
    try:
        body = response.json()
        details = (body.get("error") or {}).get("details") or []
        for detail in details:
            if isinstance(detail, dict) and detail.get("retryDelay"):
                wait = _parse_duration(detail.get("retryDelay"))
                if wait is not None:
                    break
    except (ValueError, AttributeError, TypeError):
        wait = None
    if wait is None:
        wait = _parse_duration(response.headers.get("retry-after"))
    if wait is None:
        wait = DEFAULT_RATE_LIMIT_WAIT
    return max(0.0, min(wait, MAX_RATE_LIMIT_WAIT))


def _error_message(response: httpx.Response) -> str:
    try:
        body = response.json()
        message = ((body.get("error") or {}).get("message")) if isinstance(body, dict) else None
    except (ValueError, AttributeError):
        message = None
    return str(message or response.reason_phrase or "request failed")[:200]


def parse_response(raw: dict) -> GeminiResponse:
    """Turn a generateContent JSON body into a ``GeminiResponse`` (§4.4)."""
    candidates = raw.get("candidates") or []
    block_reason = (raw.get("promptFeedback") or {}).get("blockReason")
    usage = raw.get("usageMetadata") or {}
    if not candidates or not isinstance(candidates[0], dict):
        return GeminiResponse(
            raw=raw, text="", function_calls=[], content=None, finish_reason=None,
            block_reason=block_reason, blocked=bool(block_reason), usage=usage,
        )
    cand = candidates[0]
    content = cand.get("content")
    if not isinstance(content, dict):
        content = {"role": "model", "parts": []}
    if not content.get("role"):
        content["role"] = "model"
    parts = content.get("parts") or []
    texts: List[str] = []
    calls: List[FunctionCall] = []
    for part in parts:
        if not isinstance(part, dict):
            continue
        if isinstance(part.get("text"), str) and not part.get("thought"):
            texts.append(part["text"])
        fc = part.get("functionCall")
        if isinstance(fc, dict) and fc.get("name"):
            args = fc.get("args")
            calls.append(FunctionCall(str(fc["name"]), args if isinstance(args, dict) else {}, fc.get("id")))
    finish_reason = cand.get("finishReason")
    blocked = bool(block_reason) or finish_reason in BLOCK_FINISH_REASONS
    return GeminiResponse(
        raw=raw, text="".join(texts), function_calls=calls, content=content,
        finish_reason=finish_reason, block_reason=block_reason, blocked=blocked, usage=usage,
    )


def _event_text(event: Any) -> str:
    """Non-thought text of one streamed event."""
    if not isinstance(event, dict):
        return ""
    candidates = event.get("candidates") or []
    if not candidates or not isinstance(candidates[0], dict):
        return ""
    parts = (candidates[0].get("content") or {}).get("parts") or []
    return "".join(
        p["text"] for p in parts
        if isinstance(p, dict) and isinstance(p.get("text"), str) and not p.get("thought")
    )


# ---------------------------------------------------------------------------
# generateContent with retries
# ---------------------------------------------------------------------------


async def _generate_impl(
    contents: List[dict],
    system: Optional[str],
    tools: Optional[List[dict]],
    tool_config: Optional[dict],
    generation_config: Optional[dict],
    model: Optional[str],
    timeout: Optional[float],
    max_retries: Optional[int],
    total_timeout: Optional[float],
    secret_arg: Optional[str],
    /,
) -> GeminiResponse:
    secret = _resolve_secret(secret_arg)
    if not secret:
        raise GeminiNotConfigured()
    per_attempt = float(settings.GEMINI_TIMEOUT_SECONDS if timeout is None else timeout)
    retries = int(settings.GEMINI_MAX_RETRIES if max_retries is None else max_retries)
    total = float(settings.GEMINI_TOTAL_TIMEOUT_SECONDS if total_timeout is None else total_timeout)
    # A caller that asks for one long attempt gets it; the cap bounds the rest.
    total = max(total, per_attempt)
    url = model_url(model or settings.GEMINI_MODEL, "generateContent")
    body = _build_body(contents, system, tools, tool_config, generation_config)
    headers = auth_headers(secret)

    attempts = max(1, retries + 1)
    started = time.monotonic()
    for attempt in range(attempts):
        elapsed = time.monotonic() - started
        attempt_timeout = max(1.0, min(per_attempt, total - elapsed))
        error: GeminiError
        try:
            async with httpx.AsyncClient(timeout=attempt_timeout, transport=_TRANSPORT) as client:
                response = await client.post(url, headers=headers, json=body)
        except httpx.TimeoutException:
            error = GeminiError("Gemini request timed out", reason="timeout")
            wait = float(2 ** attempt)
        except httpx.TransportError as exc:
            error = GeminiError(f"Gemini network error ({type(exc).__name__})", reason="network")
            wait = float(2 ** attempt)
        except httpx.HTTPError as exc:  # decoding, redirects, ...: not retryable
            raise GeminiError(f"Gemini request failed ({type(exc).__name__})", reason="network") from exc
        else:
            status = response.status_code
            if status == 200:
                try:
                    raw = response.json()
                except ValueError as exc:
                    raise GeminiError("Gemini returned invalid JSON", status=200, reason="parse") from exc
                if not isinstance(raw, dict):
                    raise GeminiError("Gemini returned an unexpected body", status=200, reason="parse")
                return parse_response(raw)
            if status == 429:
                error = GeminiError("Gemini rate limit reached", status=429, reason="http")
                wait = _rate_limit_wait(response)
            elif status in RETRYABLE_STATUS:
                error = GeminiError(f"Gemini HTTP {status}", status=status, reason="http")
                wait = float(2 ** attempt)
            else:
                raise GeminiError(f"Gemini HTTP {status}: {_error_message(response)}", status=status, reason="http")

        if attempt >= attempts - 1:
            raise error
        elapsed = time.monotonic() - started
        if elapsed + wait > total:
            raise GeminiError(
                f"Gemini call exceeded its {total:.0f}s budget ({error})", status=error.status, reason="deadline"
            )
        log.warning("Gemini attempt %d/%d failed (%s); retrying in %.1fs", attempt + 1, attempts, error, wait)
        await _sleep(wait)
    raise GeminiError("Gemini call failed", reason="http")  # pragma: no cover - loop always returns/raises


async def generate(
    *,
    contents: List[dict],
    system: Optional[str] = None,
    tools: Optional[List[dict]] = None,
    tool_config: Optional[dict] = None,
    generation_config: Optional[dict] = None,
    model: Optional[str] = None,
    timeout: Optional[float] = None,
    max_retries: Optional[int] = None,
    total_timeout: Optional[float] = None,
    api_key: Optional[str] = None,
) -> GeminiResponse:
    """POST ``:generateContent``; raises ``GeminiError`` (``GeminiNotConfigured`` without a credential)."""
    return await _generate_impl(
        contents, system, tools, tool_config, generation_config,
        model, timeout, max_retries, total_timeout, api_key,
    )


def _generation_config(temperature: Optional[float], max_output_tokens: Optional[int], json_mode: bool) -> dict:
    config: Dict[str, Any] = {}
    if temperature is not None:
        config["temperature"] = temperature
    if max_output_tokens is not None:
        config["maxOutputTokens"] = max_output_tokens
    if json_mode:
        config["responseMimeType"] = "application/json"
    return config


async def _text_or_none(
    contents: List[dict],
    system: Optional[str],
    config: dict,
    model: Optional[str],
    timeout: Optional[float],
    max_retries: Optional[int],
    secret_arg: Optional[str],
    /,
) -> Optional[str]:
    try:
        response = await _generate_impl(
            contents, system, None, None, config or None, model, timeout, max_retries, None, secret_arg,
        )
    except GeminiNotConfigured:
        return None
    except GeminiError as exc:
        log.warning("Gemini call failed: %s", exc)
        return None
    except Exception:  # never raise from the soft helpers
        log.exception("Gemini call failed unexpectedly")
        return None
    if response.blocked:
        log.warning("Gemini response blocked (finish=%s, block=%s)", response.finish_reason, response.block_reason)
        return None
    text = (response.text or "").strip()
    return text or None


async def generate_text(
    *,
    contents: List[dict],
    system: Optional[str] = None,
    temperature: Optional[float] = None,
    max_output_tokens: Optional[int] = None,
    timeout: Optional[float] = None,
    max_retries: Optional[int] = None,
    model: Optional[str] = None,
    api_key: Optional[str] = None,
) -> Optional[str]:
    """Plain text or ``None`` (error, blocked or empty). Never raises."""
    config = _generation_config(temperature, max_output_tokens, json_mode=False)
    return await _text_or_none(contents, system, config, model, timeout, max_retries, api_key)


def _strip_fences(text: str) -> str:
    return re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.MULTILINE | re.IGNORECASE).strip()


async def generate_json(
    *,
    contents: List[dict],
    system: Optional[str] = None,
    temperature: Optional[float] = None,
    max_output_tokens: Optional[int] = None,
    timeout: Optional[float] = None,
    max_retries: Optional[int] = None,
    model: Optional[str] = None,
    api_key: Optional[str] = None,
) -> Optional[dict]:
    """A JSON object or ``None`` (error, blocked, empty, non-object). Never raises."""
    config = _generation_config(temperature, max_output_tokens, json_mode=True)
    text = await _text_or_none(contents, system, config, model, timeout, max_retries, api_key)
    if text is None:
        return None
    try:
        parsed = json.loads(_strip_fences(text))
    except ValueError:
        log.warning("Gemini returned non-JSON content (%d chars)", len(text))
        return None
    if not isinstance(parsed, dict):
        log.warning("Gemini returned a non-object JSON value")
        return None
    return parsed


# ---------------------------------------------------------------------------
# Streaming
# ---------------------------------------------------------------------------


async def stream_text(
    *,
    contents: List[dict],
    system: Optional[str] = None,
    generation_config: Optional[dict] = None,
    model: Optional[str] = None,
    timeout: Optional[float] = None,
    api_key: Optional[str] = None,
) -> AsyncIterator[str]:
    """Yield the non-thought text of each SSE event of ``:streamGenerateContent?alt=sse``.

    Raises ``GeminiError`` while iterating (``GeminiNotConfigured`` first when
    there is no credential). Connect-phase failures follow the retry policy of
    ``generate``; nothing is retried once text has started streaming.
    """
    secret = _resolve_secret(api_key)
    if not secret:
        raise GeminiNotConfigured()
    per_attempt = float(settings.GEMINI_TIMEOUT_SECONDS if timeout is None else timeout)
    total = max(float(settings.GEMINI_TOTAL_TIMEOUT_SECONDS), per_attempt)
    attempts = max(1, int(settings.GEMINI_MAX_RETRIES) + 1)
    url = model_url(model or settings.GEMINI_MODEL, "streamGenerateContent") + "?alt=sse"
    body = _build_body(contents, system, None, None, generation_config)
    headers = auth_headers(secret)

    started_at = time.monotonic()
    for attempt in range(attempts):
        streaming = False
        error: Optional[GeminiError] = None
        wait = float(2 ** attempt)
        client = httpx.AsyncClient(timeout=per_attempt, transport=_TRANSPORT)
        try:
            async with client.stream("POST", url, headers=headers, json=body) as response:
                status = response.status_code
                if status != 200:
                    await response.aread()
                    if status == 429:
                        error = GeminiError("Gemini rate limit reached", status=429, reason="http")
                        wait = _rate_limit_wait(response)
                    elif status in RETRYABLE_STATUS:
                        error = GeminiError(f"Gemini HTTP {status}", status=status, reason="http")
                    else:
                        raise GeminiError(
                            f"Gemini HTTP {status}: {_error_message(response)}", status=status, reason="http"
                        )
                else:
                    streaming = True
                    async for line in response.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        payload = line[5:].strip()
                        if not payload or payload == "[DONE]":
                            continue
                        try:
                            event = json.loads(payload)
                        except ValueError:
                            continue
                        text = _event_text(event)
                        if text:
                            yield text
                    return
        except httpx.TimeoutException as exc:
            if streaming:
                raise GeminiError("Gemini stream timed out", reason="timeout") from exc
            error = GeminiError("Gemini request timed out", reason="timeout")
        except httpx.TransportError as exc:
            if streaming:
                raise GeminiError(f"Gemini stream interrupted ({type(exc).__name__})", reason="network") from exc
            error = GeminiError(f"Gemini network error ({type(exc).__name__})", reason="network")
        except httpx.HTTPError as exc:
            raise GeminiError(f"Gemini stream failed ({type(exc).__name__})", reason="network") from exc
        finally:
            await client.aclose()

        if error is None:  # pragma: no cover - every non-returning path sets it
            error = GeminiError("Gemini stream failed", reason="http")
        if attempt >= attempts - 1:
            raise error
        if (time.monotonic() - started_at) + wait > total:
            raise GeminiError(
                f"Gemini stream exceeded its {total:.0f}s budget ({error})", status=error.status, reason="deadline"
            )
        log.warning("Gemini stream attempt %d/%d failed (%s); retrying in %.1fs", attempt + 1, attempts, error, wait)
        await _sleep(wait)
