"""Per-turn copilot context, built once from the request (tolerant of missing keys)."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

from app.agents.modes import AgentMode
from app.agents.roles import resolve_role
from app.schemas import QueryRequest

DEFAULT_TIMEZONE = "Asia/Kolkata"
_ID_VALUE_RE = re.compile(r"^[A-Za-z0-9_:.-]{1,64}$")


@dataclass
class CopilotContext:
    role: str
    session_id: str
    request_id: str
    user_query: str
    actor: Optional[Dict[str, Any]]
    now: datetime
    tz: Any
    tz_name: str
    profile: Dict[str, Any] = field(default_factory=dict)
    college_name: Optional[str] = None
    selected_job: Optional[Dict[str, Any]] = None
    ui_context: Dict[str, Any] = field(default_factory=lambda: {"panel": None, "params": {}})
    denied_mode: Optional[AgentMode] = None
    past_messages: List[Any] = field(default_factory=list)

    @property
    def display_name(self) -> Optional[str]:
        for source in (self.actor or {}, self.profile or {}):
            name = source.get("name") if isinstance(source, dict) else None
            if isinstance(name, str) and name.strip():
                return name.strip()
        return None

    @property
    def first_name(self) -> Optional[str]:
        name = self.display_name
        return name.split()[0] if name else None

    @property
    def local_now(self) -> datetime:
        return self.now.astimezone(self.tz)


def _parse_now(value: Any) -> datetime:
    if isinstance(value, str) and value.strip():
        try:
            parsed = datetime.fromisoformat(value.strip())
        except ValueError:
            parsed = None
        if parsed is not None:
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc)


def _parse_timezone(value: Any) -> tuple[Any, str]:
    name = value.strip() if isinstance(value, str) and value.strip() else DEFAULT_TIMEZONE
    try:
        return ZoneInfo(name), name
    except Exception:
        try:
            return ZoneInfo(DEFAULT_TIMEZONE), DEFAULT_TIMEZONE
        except Exception:
            return timezone.utc, "UTC"


def normalize_ui_context(value: Any) -> Dict[str, Any]:
    """``{panel, params}`` from Node's ``ui_context`` (tolerates activePanel/panelParams)."""
    if not isinstance(value, dict):
        return {"panel": None, "params": {}}
    panel = value.get("panel") or value.get("activePanel")
    params = value.get("params")
    if not isinstance(params, dict):
        params = value.get("panelParams") if isinstance(value.get("panelParams"), dict) else {}
    clean: Dict[str, Any] = {}
    for key, raw in list(params.items())[:20]:
        if not isinstance(key, str):
            continue
        if isinstance(raw, bool) or isinstance(raw, (int, float)):
            clean[key[:40]] = raw
        elif isinstance(raw, str) and len(raw) <= 200:
            clean[key[:40]] = raw
    return {"panel": panel[:64] if isinstance(panel, str) and panel else None, "params": clean}


def ui_ids(ui_context: Dict[str, Any]) -> Dict[str, str]:
    """Id-like params (``courseId``, ``sessionId``, ``jobId``, ...) with safe values only."""
    params = ui_context.get("params") if isinstance(ui_context, dict) else None
    out: Dict[str, str] = {}
    for key, value in (params or {}).items():
        if not isinstance(key, str) or not key.endswith("Id"):
            continue
        text = str(value)
        if _ID_VALUE_RE.match(text):
            out[key] = text
    return out


def build_context(req: QueryRequest) -> CopilotContext:
    meta = req.meta_data if isinstance(req.meta_data, dict) else {}
    actor = meta.get("actor") if isinstance(meta.get("actor"), dict) else None
    tz, tz_name = _parse_timezone(meta.get("timezone"))
    routing = meta.get("routing") if isinstance(meta.get("routing"), dict) else {}
    denied = AgentMode.from_name(routing.get("denied_mode")) if routing.get("denied_mode") else None
    profile = meta.get("profile") if isinstance(meta.get("profile"), dict) else {}
    college = meta.get("college_name")
    selected_job = meta.get("selected_job") if isinstance(meta.get("selected_job"), dict) else None
    return CopilotContext(
        role=resolve_role(req),
        session_id=req.sessionId or "",
        request_id=req.requestId,
        user_query=(req.user_query or "").strip(),
        actor=actor,
        now=_parse_now(meta.get("now")),
        tz=tz,
        tz_name=tz_name,
        profile=profile,
        college_name=college.strip() if isinstance(college, str) and college.strip() else None,
        selected_job=selected_job,
        ui_context=normalize_ui_context(meta.get("ui_context")),
        denied_mode=denied if denied is not AgentMode.COPILOT else None,
        past_messages=list(req.past_messages or []),
    )
