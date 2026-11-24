"""Role-aware routing (PYTHON.md §3): every row of the §3.7 acceptance table."""

import pytest

from fakes import FakeCopilotTools, FakeSio, install_copilot, make_req
from app import orchestrator
from app.agents import REGISTRY
from app.agents.copilot import session as copilot_session
from app.agents.copilot.session import PendingAction
from app.agents.modes import AgentMode
from app.agents.roles import ROLE_MODES, allowed_modes, is_mode_allowed, resolve_role
from app.orchestrator import MODE_SWITCH_HEADERS, RouteDecision, resolve_mode, route_query

C = AgentMode.COPILOT

# (role, mode_name, text, expected mode, switch line?, extra expectations)
ROWS = [
    ("student", None, "hi", C, False, {"reason": "fallback"}),
    ("student", "banana", "hi", C, False, {"reason": "fallback"}),
    ("teacher", None, "what can you do", C, True, {"reason": "routed"}),
    ("student", None, "show my attendance", C, True, {}),
    ("student", None, "mark my attendance", C, True, {}),
    ("teacher", None, "schedule a class for tomorrow 10am", C, True, {}),
    ("teacher", None, "generate a QR code for my class", C, True, {}),
    ("student", None, "show my applications", C, True, {}),
    ("student", None, "apply to this job", C, True, {}),
    ("student", None, "find me software jobs in Bangalore", AgentMode.JOBS, True, {}),
    ("student", None, "add the 2nd job to my wishlist", AgentMode.JOBS, True, {}),
    ("tpo", None, "add the 2nd job to my wishlist", AgentMode.JOBS, True, {}),
    ("student", "jobs-finder", "add the 2nd job to my wishlist", AgentMode.JOBS, False, {"reason": "sticky"}),
    ("student", None, "find jobs and build my resume", C, False, {"reason": "fallback", "denied_mode": None}),
    ("student", None, "post a job for Infosys", C, False, {"denied_mode": AgentMode.JOB_CREATION}),
    ("student", "job-creation", "post a job for Infosys", C, False, {"denied_mode": AgentMode.JOB_CREATION}),
    ("student", "gap-analysis", "do a gap analysis of the curriculum", C, False, {"denied_mode": AgentMode.GAP_ANALYSIS}),
    ("tpo", None, "post a job for Infosys", AgentMode.JOB_CREATION, True, {}),
    ("admin", None, "do a gap analysis of the curriculum", AgentMode.GAP_ANALYSIS, True, {}),
    ("teacher", None, "find me python jobs", C, False, {"denied_mode": AgentMode.JOBS}),
    ("teacher", "ai-interviewer", "I want to give a mock interview", C, False, {"denied_mode": AgentMode.INTERVIEW}),
    ("student", "copilot", "start a mock interview", AgentMode.INTERVIEW, True, {"left_mode": C, "reason": "switch"}),
    ("student", "copilot", "yes", C, False, {"reason": "sticky"}),
    ("student", "ai-interviewer", "I built an attendance system with React", AgentMode.INTERVIEW, False, {"reason": "sticky"}),
    ("student", None, "can I apply to Google?", AgentMode.ELIGIBILITY, True, {}),
    ("student", None, "https://boards.greenhouse.io/acme", AgentMode.JOBS, True, {}),
]


@pytest.mark.parametrize("role,mode_name,text,expected,switch,extra", ROWS)
async def test_routing_table(role, mode_name, text, expected, switch, extra):
    decision = await resolve_mode(make_req(text, role=role, mode_name=mode_name), resolve_role(make_req(text, role=role)))
    assert isinstance(decision, RouteDecision)
    assert decision.mode is expected, (text, decision)
    assert decision.emit_switch is switch, (text, decision)
    for key, value in extra.items():
        assert getattr(decision, key) == value, (text, key, decision)


async def test_confirm_with_pending_copilot_action_goes_to_copilot():
    copilot_session.store.set_pending("u1:s1", PendingAction("attendance_end_session", {}, "End the session?"))
    decision = await resolve_mode(make_req("Confirm", role="student"), "student")
    assert decision.mode is C
    assert decision.emit_switch is False
    assert decision.reason == "copilot_pending"


def test_admin_actor_overrides_user_role():
    req = make_req("x", role="admin")
    assert req.user_role == "tpo"
    assert resolve_role(req) == "admin"


def test_resolve_role_fallbacks():
    assert resolve_role(make_req("x", role="teacher")) == "teacher"
    no_actor = make_req("x", role="tpo")
    no_actor.meta_data.pop("actor")
    assert resolve_role(no_actor) == "tpo"
    weird = make_req("x", role="wizard")
    assert resolve_role(weird) == "student"
    bare = make_req("x")
    bare.meta_data.pop("actor")
    bare.user_role = None
    assert resolve_role(bare) == "student"


def test_role_mode_table():
    S = AgentMode
    assert ROLE_MODES["student"] == {S.COPILOT, S.JOBS, S.ELIGIBILITY, S.RESUME, S.INTERVIEW,
                                     S.LEARNING_RECOMMENDATION, S.PR_OUTREACH, S.ALUMNI_CONNECT}
    staff = {S.COPILOT, S.JOBS, S.ELIGIBILITY, S.JOB_CREATION, S.GAP_ANALYSIS, S.PR_OUTREACH}
    assert ROLE_MODES["tpo"] == staff
    assert ROLE_MODES["admin"] == staff
    for role in ("teacher", "company", "alumni"):
        assert ROLE_MODES[role] == {S.COPILOT}
    assert allowed_modes(None) == frozenset(AgentMode)
    assert not is_mode_allowed(S.JOB_CREATION, "student")
    assert not is_mode_allowed(S.GAP_ANALYSIS, "student")
    for role in ROLE_MODES:
        assert is_mode_allowed(C, role)


def test_every_mode_is_registered_with_a_switch_header():
    for mode in AgentMode:
        assert mode.value in REGISTRY, mode
        assert mode in MODE_SWITCH_HEADERS, mode
    assert MODE_SWITCH_HEADERS[C] == "mode:switch:copilot"


def test_attendance_is_served_by_the_copilot():
    for name in ("copilot", "assistant", "agent", "general", "campus-assistant", "attendance", "attendance-agent"):
        assert AgentMode.from_name(name) is C


def test_route_query_without_role_keeps_job_feed_rules():
    assert route_query("post a job for Infosys") is AgentMode.JOB_CREATION
    assert route_query("add the 2nd job to my wishlist") is AgentMode.JOBS
    assert route_query("mark job 1 as applied") is AgentMode.JOBS


async def test_fallback_emits_no_switch_line_and_copilot_rules_do(monkeypatch):
    install_copilot(monkeypatch, FakeCopilotTools(role="student"))
    sio = FakeSio()
    await orchestrator.handle(make_req("hi"), sio, "sid")
    assert not any(h.startswith("mode:switch") for h in sio.headers)
    assert "mode:none" not in sio.headers
    assert sio.payloads[-1]["isEnd"] is True

    sio = FakeSio()
    await orchestrator.handle(make_req("show my attendance", request_id="r2"), sio, "sid")
    assert sio.headers[0] == "mode:switch:copilot"
    assert sio.payloads[-1]["isEnd"] is True
