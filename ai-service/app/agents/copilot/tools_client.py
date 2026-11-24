"""Copilot view of the Node tool API: typed manifest, typed results, caching.

Built on the shared ``app.tools_client`` (looked up at call time, so tests can
monkeypatch ``app.tools_client.execute_tool`` / ``fetch_manifest``).
Transport failures (``NO_TOOL_TOKEN``, ``AUTH``, ``UNAVAILABLE``) raise
``ToolsUnavailable``; every other ``ok: false`` is a normal ``ToolResult`` that
is fed back to the LLM or rendered by the planner.
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set, Tuple

from app import tools_client as base_client
from app.config import settings

log = logging.getLogger("copilot.tools")

_TOOL_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{2,63}$")


@dataclass
class ToolSpec:
    name: str
    description: str
    parameters: Optional[dict]
    confirm: bool

    @property
    def properties(self) -> Dict[str, Any]:
        props = (self.parameters or {}).get("properties") if isinstance(self.parameters, dict) else None
        return props if isinstance(props, dict) else {}

    @property
    def required(self) -> List[str]:
        req = (self.parameters or {}).get("required") if isinstance(self.parameters, dict) else None
        return [str(name) for name in req if isinstance(name, str)] if isinstance(req, list) else []


@dataclass
class Manifest:
    role: str
    tools: List[ToolSpec] = field(default_factory=list)

    def get(self, name: str) -> Optional[ToolSpec]:
        for spec in self.tools:
            if spec.name == name:
                return spec
        return None

    @property
    def names(self) -> Set[str]:
        return {spec.name for spec in self.tools}

    @classmethod
    def from_payload(cls, role: str, tools: Any) -> "Manifest":
        specs: List[ToolSpec] = []
        seen: Set[str] = set()
        for raw in tools if isinstance(tools, list) else []:
            if not isinstance(raw, dict):
                continue
            name = raw.get("name")
            if not isinstance(name, str) or not _TOOL_NAME_RE.match(name) or name in seen:
                continue
            seen.add(name)
            description = raw.get("description")
            parameters = raw.get("parameters")
            specs.append(ToolSpec(
                name=name,
                description=description.strip() if isinstance(description, str) else "",
                parameters=parameters if isinstance(parameters, dict) else None,
                confirm=raw.get("confirm") is True,
            ))
        return cls(role=role, tools=specs)


def _normalize_ui(raw: Any) -> List[Dict[str, Any]]:
    items = raw if isinstance(raw, list) else ([raw] if isinstance(raw, dict) else [])
    out: List[Dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        panel = item.get("panel")
        if not isinstance(panel, str) or not panel.strip():
            continue
        action: Dict[str, Any] = {
            "panel": panel.strip(),
            "params": item.get("params") if isinstance(item.get("params"), dict) else {},
        }
        if "data" in item:
            action["data"] = item["data"]
        out.append(action)
    return out


def _normalize_candidates(raw: Any) -> Optional[List[Dict[str, str]]]:
    if not isinstance(raw, list):
        return None
    out: List[Dict[str, str]] = []
    for candidate in raw:
        if not isinstance(candidate, dict):
            continue
        cid = candidate.get("id") or candidate.get("_id")
        if cid is None or str(cid).strip() == "":
            continue
        label = candidate.get("label") or candidate.get("name") or cid
        out.append({"id": str(cid), "label": str(label)})
    return out or None


@dataclass
class ToolResult:
    tool: str
    ok: bool
    summary: str = ""
    data: Any = None
    ui: List[Dict[str, Any]] = field(default_factory=list)
    error: Optional[str] = None
    message: str = ""
    needs_confirmation: bool = False
    preview: str = ""
    args: Optional[dict] = None
    candidates: Optional[List[Dict[str, str]]] = None

    @classmethod
    def from_payload(cls, tool: str, payload: dict) -> "ToolResult":
        payload = payload if isinstance(payload, dict) else {}
        ok = payload.get("ok") is True
        error = payload.get("error")
        return cls(
            tool=str(payload.get("tool") or tool),
            ok=ok,
            summary=str(payload.get("summary") or ""),
            data=payload.get("data"),
            ui=_normalize_ui(payload.get("ui")) if ok else [],
            error=None if ok else (str(error) if error else None),
            message=str(payload.get("message") or ""),
            needs_confirmation=payload.get("needs_confirmation") is True,
            preview=str(payload.get("preview") or ""),
            args=payload.get("args") if isinstance(payload.get("args"), dict) else None,
            candidates=_normalize_candidates(payload.get("candidates")),
        )

    @classmethod
    def unknown(cls, tool: str) -> "ToolResult":
        return cls(tool=tool, ok=False, error="UNKNOWN_TOOL", message="No such tool")


class ToolsUnavailable(Exception):
    def __init__(self, code: str, message: str = "") -> None:
        super().__init__(message or code)
        self.code = code


# (tools_url, role) -> (expires_at, Manifest)
_MANIFEST_CACHE: Dict[Tuple[str, str], Tuple[float, Manifest]] = {}


def clear_manifest_cache() -> None:
    _MANIFEST_CACHE.clear()


class CopilotTools:
    def __init__(self, meta_data: dict, *, request_id: str) -> None:
        self.meta_data = meta_data if isinstance(meta_data, dict) else {}
        self.request_id = request_id

    @property
    def _tools_url(self) -> str:
        return str(self.meta_data.get("tools_url") or "")

    async def manifest(self, role: str) -> Manifest:
        key = (self._tools_url, role)
        now = time.monotonic()
        cached = _MANIFEST_CACHE.get(key)
        if cached and cached[0] > now:
            return cached[1]
        result = await base_client.fetch_manifest(
            self.meta_data,
            timeout=float(settings.TOOLS_HTTP_TIMEOUT_SECONDS),
            request_id=self.request_id,
        )
        if result.get("ok") is True:
            manifest = Manifest.from_payload(str(result.get("role") or role), result.get("tools"))
            _MANIFEST_CACHE[key] = (now + float(settings.COPILOT_MANIFEST_TTL_SECONDS), manifest)
            return manifest
        if cached:
            log.warning("[%s] manifest refresh failed (%s); reusing the cached copy", self.request_id, result.get("error"))
            return cached[1]
        code = str(result.get("error") or "UNAVAILABLE")
        raise ToolsUnavailable(code if code in base_client.TRANSPORT_ERRORS else "UNAVAILABLE", str(result.get("message") or ""))

    async def execute(self, tool: str, args: dict, *, confirmed: bool = False) -> ToolResult:
        """Run one tool (the shared client logs request id, tool, ok, error code and duration)."""
        payload = await base_client.execute_tool(
            self.meta_data,
            tool,
            args if isinstance(args, dict) else {},
            confirmed=confirmed,
            timeout=float(settings.TOOLS_HTTP_TIMEOUT_SECONDS),
            request_id=self.request_id,
        )
        payload = payload if isinstance(payload, dict) else {"ok": False, "error": "INTERNAL", "message": "Unexpected tool response."}
        code = payload.get("error")
        if payload.get("ok") is not True and code in base_client.TRANSPORT_ERRORS:
            raise ToolsUnavailable(str(code), str(payload.get("message") or ""))
        return ToolResult.from_payload(tool, payload)


def make_copilot_tools(meta_data: dict, *, request_id: str) -> CopilotTools:
    return CopilotTools(meta_data, request_id=request_id)
