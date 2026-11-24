"""Low-level client for the Node agent-tool API (AGENT-TOOLS.md §3).

Every query's ``meta_data`` carries ``tools_url`` (``.../api/v1/agent-tools``)
and ``tool_token`` (a 15-minute Bearer token that acts as the logged-in user).
Both the copilot and the jobs-finder call Node through this module.

``execute_tool`` and ``fetch_manifest`` never raise and always return a dict
with ``ok``. Transport-level failures use the codes in ``TRANSPORT_ERRORS``
(plus ``INTERNAL`` for unexpected statuses / bodies); tool-level failures are
whatever Node returned (``VALIDATION``, ``FORBIDDEN``, ``AMBIGUOUS``, ...).
Responses may arrive raw or inside the standard ``{statusCode, data, message,
success}`` envelope -- both are accepted. The token is never logged and never
put into a message.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Dict, Optional

import httpx

log = logging.getLogger("tools_client")

TRANSPORT_ERRORS = frozenset({"NO_TOOL_TOKEN", "AUTH", "UNAVAILABLE"})
_UNAVAILABLE_STATUS = {404, 408, 429}

# Test seam: an httpx transport (e.g. ``httpx.MockTransport``).
_TRANSPORT: Optional[httpx.AsyncBaseTransport] = None

NO_TOKEN_MESSAGE = "The assistant is not connected to the campus services (no tool token was provided)."
AUTH_MESSAGE = "The campus services rejected the assistant's credentials."
TIMEOUT_MESSAGE = "The campus services took too long to answer."
NETWORK_MESSAGE = "The campus services could not be reached."
INTERNAL_MESSAGE = "The campus services returned an unexpected response."


def _meta(meta_data: Optional[dict]) -> dict:
    return meta_data if isinstance(meta_data, dict) else {}


def has_tool_access(meta_data: Optional[dict]) -> bool:
    """True when ``meta_data`` has a string ``tool_token`` and an http(s) ``tools_url``."""
    meta = _meta(meta_data)
    token = meta.get("tool_token")
    url = meta.get("tools_url")
    return (
        isinstance(token, str) and bool(token.strip())
        and isinstance(url, str) and url.strip().lower().startswith(("http://", "https://"))
    )


def _headers(meta: dict, request_id: Optional[str]) -> Dict[str, str]:
    headers = {
        "Authorization": f"Bearer {meta['tool_token'].strip()}",
        "Accept": "application/json",
    }
    if request_id:
        headers["X-Request-Id"] = str(request_id)[:128]
    return headers


def _failure(code: str, message: str) -> dict:
    return {"ok": False, "error": code, "message": message}


def _server_message(body: Any) -> Optional[str]:
    if isinstance(body, dict):
        message = body.get("message")
        if isinstance(message, str) and message.strip():
            return message.strip()[:300]
    return None


def _envelope_code(body: dict) -> Optional[str]:
    errors = body.get("errors")
    if isinstance(errors, list) and errors and isinstance(errors[0], dict):
        code = errors[0].get("code")
        if isinstance(code, str) and code:
            return code
    return None


def _unwrap(body: Any) -> Any:
    """Standard envelope -> its ``data``; anything else unchanged."""
    if isinstance(body, dict) and "ok" not in body and "success" in body and isinstance(body.get("data"), dict):
        return body["data"]
    return body


def _status_failure(status: int, body: Any) -> dict:
    if status in (401, 403):
        return _failure("AUTH", AUTH_MESSAGE)
    if status in _UNAVAILABLE_STATUS or status >= 500:
        return _failure("UNAVAILABLE", f"The campus services are unavailable right now (HTTP {status}).")
    message = _server_message(body) or f"{INTERNAL_MESSAGE} (HTTP {status})"
    code = _envelope_code(body) if isinstance(body, dict) else None
    return _failure(code or "INTERNAL", message)


def _json(response: httpx.Response) -> Any:
    try:
        return response.json()
    except ValueError:
        return None


async def execute_tool(
    meta_data: Optional[dict],
    tool: str,
    args: dict,
    *,
    confirmed: bool = False,
    timeout: float = 20.0,
    request_id: Optional[str] = None,
) -> dict:
    """``POST {tools_url}/execute``. Never raises, never retries."""
    meta = _meta(meta_data)
    if not has_tool_access(meta):
        return _failure("NO_TOOL_TOKEN", NO_TOKEN_MESSAGE)
    url = meta["tools_url"].strip().rstrip("/") + "/execute"
    body: Dict[str, Any] = {"tool": tool, "args": args if isinstance(args, dict) else {}}
    if confirmed:
        body["confirmed"] = True

    started = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=timeout, transport=_TRANSPORT) as client:
            response = await client.post(url, json=body, headers=_headers(meta, request_id))
    except httpx.TimeoutException:
        result = _failure("UNAVAILABLE", TIMEOUT_MESSAGE)
    except httpx.HTTPError as exc:
        log.warning("[%s] tool %s transport error: %s", request_id or "-", tool, type(exc).__name__)
        result = _failure("UNAVAILABLE", NETWORK_MESSAGE)
    else:
        payload = _json(response)
        if not (200 <= response.status_code < 300):
            result = _status_failure(response.status_code, payload)
        elif not isinstance(payload, dict):
            result = _failure("INTERNAL", INTERNAL_MESSAGE)
        else:
            data = _unwrap(payload)
            if not isinstance(data, dict):
                result = _failure("INTERNAL", INTERNAL_MESSAGE)
            elif "ok" not in data:
                if data.get("success") is False:
                    result = _failure(_envelope_code(data) or "INTERNAL", _server_message(data) or INTERNAL_MESSAGE)
                else:
                    result = _failure("INTERNAL", INTERNAL_MESSAGE)
            else:
                result = data
    log.info(
        "[%s] tool %s ok=%s error=%s %.0fms",
        request_id or "-", tool, result.get("ok") is True, result.get("error"),
        (time.monotonic() - started) * 1000,
    )
    return result


async def fetch_manifest(
    meta_data: Optional[dict],
    *,
    timeout: float = 10.0,
    request_id: Optional[str] = None,
) -> dict:
    """``GET {tools_url}/manifest`` -> ``{ok: True, role, tools}`` or ``{ok: False, error, message}``.

    One retry on a network error or 5xx only.
    """
    meta = _meta(meta_data)
    if not has_tool_access(meta):
        return _failure("NO_TOOL_TOKEN", NO_TOKEN_MESSAGE)
    url = meta["tools_url"].strip().rstrip("/") + "/manifest"
    result: dict = _failure("UNAVAILABLE", NETWORK_MESSAGE)
    for attempt in range(2):
        retry = False
        try:
            async with httpx.AsyncClient(timeout=timeout, transport=_TRANSPORT) as client:
                response = await client.get(url, headers=_headers(meta, request_id))
        except httpx.TimeoutException:
            result = _failure("UNAVAILABLE", TIMEOUT_MESSAGE)
            retry = True
        except httpx.HTTPError as exc:
            log.warning("[%s] manifest transport error: %s", request_id or "-", type(exc).__name__)
            result = _failure("UNAVAILABLE", NETWORK_MESSAGE)
            retry = True
        else:
            payload = _json(response)
            if not (200 <= response.status_code < 300):
                result = _status_failure(response.status_code, payload)
                retry = response.status_code >= 500
            else:
                data = _unwrap(payload)
                tools = data.get("tools") if isinstance(data, dict) else None
                if isinstance(tools, list):
                    role = data.get("role")
                    return {"ok": True, "role": role if isinstance(role, str) else None, "tools": tools}
                result = _failure("INTERNAL", INTERNAL_MESSAGE)
        if not retry or attempt == 1:
            break
    log.warning("[%s] manifest unavailable: %s", request_id or "-", result.get("error"))
    return result
