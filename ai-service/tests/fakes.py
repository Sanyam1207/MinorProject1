"""Test doubles: fake socket, fake Node tools, fake LLM, request builder.

The tool catalogue mirrors AGENT-TOOLS.md §5 (plus the JOB-FEED.md §10
``jobs_search_market`` extensions) so planner tests run against realistic,
role-filtered manifests. Identities are neutral fakes.
"""

from __future__ import annotations

import copy
from typing import Any, Callable, Dict, Iterable, List, Optional, Union

from app.agents.copilot.llm import LLMStep
from app.agents.copilot.tools_client import Manifest, ToolResult, ToolsUnavailable
from app.llm.gemini import FunctionCall
from app.schemas import QueryRequest

ALL = ("student", "teacher", "tpo", "admin", "company", "alumni")
STAFF = ("tpo", "admin")

S = {"type": "string"}
I = {"type": "integer"}
N = {"type": "number"}
B = {"type": "boolean"}


def _obj(properties: Dict[str, Any], required: Iterable[str] = ()) -> dict:
    return {"type": "object", "properties": properties, "required": list(required)}


# name -> (roles, confirm, parameters, description)
TOOL_CATALOGUE: Dict[str, tuple] = {
    "open_panel": (ALL, False, _obj({"panel": {"type": "string", "enum": ["schedule", "teacher.schedule"]}, "params": {"type": "object"}}, ["panel"]),
                   "Open a panel in the user's workspace."),
    "get_my_profile": (ALL, False, _obj({}), "Show the user's profile summary. Includes CGPA and skills."),
    "notifications_list": (ALL, False, _obj({"unreadOnly": B}), "List the user's notifications."),
    "notifications_mark_read": (ALL, False, _obj({"all": B, "ids": {"type": "array", "items": S}}), "Mark notifications as read."),
    "attendance_list_courses": (("teacher", "student", "tpo", "admin"), False, _obj({}), "List the user's courses."),
    "attendance_create_course": (("teacher",), True, _obj({"code": S, "name": S}, ["code", "name"]), "Create a course."),
    "attendance_list_sessions": (("teacher", "student", "tpo", "admin"), False, _obj({"course": S, "from": S, "to": S, "status": S}), "List class sessions."),
    "attendance_schedule_class": (("teacher",), True, _obj({"course": S, "when": S, "durationMinutes": I, "room": S, "topic": S}, ["course", "when"]),
                                  "Schedule a class for one of the teacher's courses. Students are notified."),
    "attendance_auto_schedule_class": (("teacher",), True, _obj({"course": S, "durationMinutes": I, "within": S, "preferredDays": {"type": "array", "items": I}, "topic": S}, ["course"]),
                                       "Find the earliest free slot and schedule a class there."),
    "attendance_reschedule_class": (("teacher",), True, _obj({"session": S, "course": S, "from": S, "when": S, "durationMinutes": I}, ["when"]),
                                    "Move a scheduled class to a new time."),
    "attendance_cancel_class": (("teacher",), True, _obj({"session": S, "course": S, "when": S, "reason": S}), "Cancel a scheduled class."),
    "attendance_start_session": (("teacher",), True, _obj({"session": S, "course": S}), "Start live QR attendance for a class."),
    "attendance_end_session": (("teacher",), True, _obj({"session": S}), "End the live attendance session."),
    "attendance_session_report": (("teacher", "tpo", "admin"), False, _obj({"session": S, "course": S, "date": S}), "Attendance report for one class session."),
    "attendance_course_report": (("teacher", "tpo", "admin"), False, _obj({"course": S, "threshold": N}, ["course"]), "Attendance report for a course, with defaulters."),
    "attendance_notify_defaulters": (("teacher",), True, _obj({"course": S, "threshold": N, "message": S}, ["course"]), "Notify students below the attendance threshold."),
    "attendance_mark_manual": (("teacher",), True, _obj({"session": S, "student": S, "status": {"type": "string", "enum": ["present", "absent", "late", "excused"]}, "note": S}, ["student", "status"]),
                               "Mark a student's attendance manually."),
    "attendance_my_summary": (("student",), False, _obj({}), "Show the student's attendance summary per course."),
    "attendance_my_schedule": (("student", "teacher"), False, _obj({"days": I}), "Show upcoming classes."),
    "attendance_join_course": (("student",), True, _obj({"joinCode": S}, ["joinCode"]), "Join a course with the teacher's join code."),
    "attendance_open_scanner": (("student",), False, _obj({}), "Open the attendance QR scanner."),
    "jobs_search_campus": (("student", "tpo", "admin", "company"), False, _obj({"query": S, "location": S, "minPackageLpa": N, "eligibleOnly": B, "limit": I}),
                           "Search the college's campus placement drives."),
    "job_details": (ALL, False, _obj({"job": S}, ["job"]), "Show one campus drive in detail."),
    "drive_apply": (("student",), True, _obj({"job": S, "resumeId": S, "coverNote": S}, ["job"]), "Apply to a campus drive."),
    "applications_list": (("student",), False, _obj({"status": S}), "List the student's applications."),
    "application_withdraw": (("student",), True, _obj({"application": S, "job": S}), "Withdraw an application."),
    "offers_list": (("student", "tpo", "admin"), False, _obj({}), "List offers."),
    "offer_respond": (("student",), True, _obj({"offer": S, "job": S, "decision": {"type": "string", "enum": ["accept", "reject"]}, "reason": S}, ["decision"]),
                      "Accept or reject an offer."),
    "training_list": (("student", "tpo", "admin"), False, _obj({"mine": B}), "List training programs."),
    "training_register": (("student",), True, _obj({"program": S}, ["program"]), "Register for a training program."),
    "drives_list": (("tpo", "admin", "company"), False, _obj({"status": S}), "List placement drives."),
    "drive_create": (("tpo", "admin", "company"), True, _obj({"title": S, "company": S, "description": S, "deadline": S}, ["title", "company", "description", "deadline"]),
                     "Create a placement drive."),
    "drive_close": (("tpo", "admin", "company"), True, _obj({"job": S}, ["job"]), "Close a drive for new applications."),
    "applicants_list": (("tpo", "admin", "company"), False, _obj({"job": S, "status": S}, ["job"]), "List applicants for a drive."),
    "application_update_status": (("tpo", "admin", "company"), True, _obj({"application": S, "status": S, "note": S}, ["application", "status"]),
                                  "Move an application to a new status."),
    "offer_create": (("tpo", "admin", "company"), True, _obj({"application": S, "ctc": S}, ["application", "ctc"]), "Extend an offer."),
    "placement_stats": (STAFF, False, _obj({}), "Placement statistics for the current academic year."),
    "announce": (STAFF, True, _obj({"title": S, "body": S, "audience": _obj({"roles": {"type": "array", "items": S}, "branch": S})}, ["title", "body", "audience"]),
                 "Send an announcement."),
    "jobs_search_market": (ALL, False, _obj({
        "query": S, "category": S,
        "jobType": {"type": "string", "enum": ["full-time", "part-time", "internship", "contract"]},
        "workType": {"type": "string", "enum": ["onsite", "remote", "hybrid"]},
        "location": S, "source": S, "sort": {"type": "string", "enum": ["match", "newest"]}, "limit": I,
    }), "Search the open-market job feed: jobs aggregated from external job boards. NOT campus drives."),
    "market_job_save": (("student",), False, _obj({"job": S, "notes": S}, ["job"]), "Save an open-market job to the student's job tracker."),
    "market_job_mark_applied": (("student",), False, _obj({"job": S, "notes": S}, ["job"]), "Mark an open-market job as applied."),
    "job_feed_sync": (STAFF, True, _obj({}), "Fetch the latest jobs from the external sources now."),
    "resume_list": (("student",), False, _obj({}), "List the student's resumes."),
    "resume_score": (("student",), False, _obj({"resume": S}), "Score a resume for ATS readiness."),
    "resume_tailor_for_job": (("student",), False, _obj({"job": S, "resume": S, "credentialId": S}, ["job"]), "Tailor a resume to a job."),
    "faculty_list": (STAFF, False, _obj({}), "List faculty members."),
    "faculty_invite": (STAFF, True, _obj({"name": S, "email": S, "department": S}, ["name", "email"]), "Invite a faculty member."),
}


def manifest_payload(role: str) -> Dict[str, Any]:
    tools = [
        {"name": name, "description": description, "parameters": copy.deepcopy(params), "confirm": confirm}
        for name, (roles, confirm, params, description) in TOOL_CATALOGUE.items()
        if role in roles
    ]
    return {"role": role, "tools": tools}


def make_manifest(role: str) -> Manifest:
    payload = manifest_payload(role)
    return Manifest.from_payload(role, payload["tools"])


class FakeSio:
    """Records ``(event, payload, to)``; payloads are deep-copied."""

    def __init__(self) -> None:
        self.events: List[tuple] = []

    async def emit(self, event: str, payload: Any, to: Optional[str] = None) -> None:
        self.events.append((event, copy.deepcopy(payload), to))

    @property
    def payloads(self) -> List[dict]:
        return [payload for event, payload, _ in self.events if event == "response"]

    @property
    def headers(self) -> List[str]:
        return [payload.get("header_message") for payload in self.payloads]


Response = Union[dict, Callable[[dict, bool], dict], Exception, List[Any]]


class FakeCopilotTools:
    """Scripted Node tools. ``responses[tool]`` is a payload, a list of payloads
    (consumed in order, the last one repeats), a callable ``(args, confirmed) ->
    payload`` or an exception to raise."""

    def __init__(
        self,
        role: str = "student",
        responses: Optional[Dict[str, Response]] = None,
        manifest: Optional[Manifest] = None,
        manifest_error: Optional[str] = None,
    ) -> None:
        self.role = role
        self.responses: Dict[str, Response] = dict(responses or {})
        self._manifest = manifest
        self.manifest_error = manifest_error
        self.calls: List[tuple] = []
        self.manifest_calls = 0
        self.factory_calls = 0

    def factory(self, meta_data: dict, *, request_id: str) -> "FakeCopilotTools":
        self.factory_calls += 1
        return self

    async def manifest(self, role: str) -> Manifest:
        self.manifest_calls += 1
        if self.manifest_error:
            raise ToolsUnavailable(self.manifest_error)
        return self._manifest or make_manifest(role)

    async def execute(self, tool: str, args: dict, *, confirmed: bool = False) -> ToolResult:
        self.calls.append((tool, copy.deepcopy(args), confirmed))
        response = self.responses.get(tool, {"ok": True, "tool": tool, "summary": f"{tool} done."})
        if isinstance(response, list):
            response = response.pop(0) if len(response) > 1 else response[0]
        if isinstance(response, Exception):
            raise response
        if callable(response):
            response = response(copy.deepcopy(args), confirmed)
        return ToolResult.from_payload(tool, copy.deepcopy(response))

    def executed(self, tool: Optional[str] = None) -> List[tuple]:
        return [call for call in self.calls if tool is None or call[0] == tool]


def step_call(name: str, args: Optional[dict] = None, *, call_id: Optional[str] = None, text: str = "",
              extra_part: Optional[dict] = None) -> LLMStep:
    """An LLM round that calls one tool (``model_content`` built like Gemini's)."""
    function_call = {"name": name, "args": args or {}}
    if call_id:
        function_call["id"] = call_id
    part: Dict[str, Any] = {"functionCall": function_call}
    if extra_part:
        part.update(extra_part)
    parts: List[dict] = ([{"text": text}] if text else []) + [part]
    return LLMStep(
        text=text,
        calls=[FunctionCall(name, args or {}, call_id)],
        model_content={"role": "model", "parts": parts},
        finish_reason="STOP",
        blocked=False,
    )


def step_calls(calls: List[tuple]) -> LLMStep:
    """An LLM round with several parallel calls ``[(name, args), ...]``."""
    parts = [{"functionCall": {"name": name, "args": args}} for name, args in calls]
    return LLMStep(
        text="",
        calls=[FunctionCall(name, args) for name, args in calls],
        model_content={"role": "model", "parts": parts},
        finish_reason="STOP",
    )


def step_text(text: str) -> LLMStep:
    return LLMStep(text=text, calls=[], model_content={"role": "model", "parts": [{"text": text}]}, finish_reason="STOP")


class FakeLLM:
    """Scripted ``GeminiCopilotLLM``: steps are LLMStep objects, exceptions to
    raise, or callables ``(call_index) -> LLMStep``. Records every call."""

    def __init__(self, steps: Optional[List[Any]] = None, *, available: bool = True, repeat_last: bool = False) -> None:
        self.steps = list(steps or [])
        self.available = available
        self.repeat_last = repeat_last
        self.calls: List[dict] = []

    async def step(self, *, system: str, contents: List[dict], declarations: List[dict], force_text: bool = False) -> LLMStep:
        index = len(self.calls)
        self.calls.append({
            "system": system,
            "contents": copy.deepcopy(contents),
            "declarations": copy.deepcopy(declarations),
            "force_text": force_text,
        })
        if not self.steps:
            return step_text("All done.")
        item = self.steps[0] if (self.repeat_last and len(self.steps) == 1) else self.steps.pop(0)
        if isinstance(item, Exception):
            raise item
        if callable(item):
            return item(index)
        return item


def make_req(
    text: str,
    role: str = "student",
    mode_name: Optional[str] = None,
    session: str = "u1:s1",
    request_id: str = "r1",
    with_tools: bool = True,
    **meta: Any,
) -> QueryRequest:
    """A query as Node sends it (neutral fake identity)."""
    meta_data: Dict[str, Any] = {
        "actor": {"user_id": "u1", "role": role, "name": "Test User", "email": "test.user@example.invalid"},
        "now": "2026-11-24T09:00:00.000Z",
        "timezone": "Asia/Kolkata",
    }
    if with_tools:
        meta_data["tool_token"] = "test-tool-token"
        meta_data["tools_url"] = "http://tools.invalid/api/v1/agent-tools"
    user_role = meta.pop("user_role", "tpo" if role == "admin" else role)
    past_messages = meta.pop("past_messages", None)
    meta_data.update(meta)
    return QueryRequest(
        requestId=request_id,
        sessionId=session,
        user_query=text,
        user_role=user_role,
        mode_name=mode_name,
        past_messages=past_messages,
        meta_data=meta_data,
    )


def install_copilot(monkeypatch, tools: FakeCopilotTools, llm: Optional[FakeLLM] = None):
    """Register a copilot wired to the fakes (``llm=None`` = unavailable LLM)."""
    from app.agents import REGISTRY
    from app.agents.copilot import CopilotAgent

    agent = CopilotAgent(tools_factory=tools.factory, llm=llm or FakeLLM(available=False))
    monkeypatch.setitem(REGISTRY, "copilot", agent)
    return agent


def needs_confirmation(tool: str, args: dict, preview: str) -> dict:
    return {"ok": False, "needs_confirmation": True, "tool": tool, "args": args, "preview": preview}
