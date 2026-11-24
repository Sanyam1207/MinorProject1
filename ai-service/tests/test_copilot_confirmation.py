"""Human confirmation of side-effecting tools (PYTHON.md §5.7 step A, §6.1)."""

import pytest

from fakes import (
    FakeCopilotTools, FakeLLM, FakeSio, install_copilot, make_req, needs_confirmation, step_call, step_calls, step_text,
)
from app import orchestrator
from app.agents.confirm import classify_reply
from app.agents.copilot import session as copilot_session
from app.agents.copilot.schemas import CANCELLED_TEXT, EXPIRED_TEXT

SID = "u1:s1"
NORMALISED = {"course": "k1", "when": "2026-11-25T04:30:00.000Z", "durationMinutes": 60, "room": "LT-2"}
PREVIEW = "Schedule CS301 · Tue 25 Nov, 10:00–11:00 · LT-2?"
SUMMARY = "Scheduled CS301 for Tue 25 Nov 10:00. 58 students notified."


def schedule_tool(args, confirmed):
    if not confirmed:
        return needs_confirmation("attendance_schedule_class", NORMALISED, PREVIEW)
    return {"ok": True, "tool": "attendance_schedule_class", "summary": SUMMARY, "data": {"session": {"_id": "s9"}},
            "ui": {"panel": "teacher.schedule", "params": {"sessionId": "s9"}}}


def teacher_tools():
    return FakeCopilotTools(role="teacher", responses={"attendance_schedule_class": schedule_tool})


async def run(text, *, mode_name=None, request_id="r1", role="teacher"):
    sio = FakeSio()
    await orchestrator.handle(make_req(text, role=role, mode_name=mode_name, request_id=request_id), sio, "sid")
    payloads = sio.payloads
    assert sum(1 for p in payloads if p.get("isEnd")) == 1 and payloads[-1]["isEnd"] is True
    return payloads


async def ask_for_confirmation(monkeypatch, tools, llm):
    install_copilot(monkeypatch, tools, llm)
    return await run("Schedule DBMS tomorrow 10am in LT-2")


async def test_needs_confirmation_ends_with_a_confirm_chunk(monkeypatch):
    tools = teacher_tools()
    llm = FakeLLM([step_call("attendance_schedule_class", {"course": "DBMS", "when": "tomorrow 10am", "room": "LT-2"})])
    payloads = await ask_for_confirmation(monkeypatch, tools, llm)

    copilot = [p for p in payloads if p["header_message"].startswith("copilot:")]
    assert [p["header_message"] for p in copilot] == ["copilot:thinking", "copilot:tool", "copilot:confirm"]
    assert copilot[1]["data"]["tool_calls"][0]["status"] == "running"
    confirm = copilot[-1]
    assert confirm["isEnd"] is True
    assert confirm["options"] == ["Confirm", "Cancel"]
    assert confirm["response"] == "**Please confirm:** " + PREVIEW
    assert confirm["data"]["pending"] == {"tool": "attendance_schedule_class", "args": NORMALISED, "preview": PREVIEW}
    assert confirm["data"]["tool_calls"][0]["status"] == "needs_confirmation"
    assert confirm["data"]["tool_calls"][0]["summary"] == PREVIEW
    pending, expired = copilot_session.store.peek_pending(SID)
    assert pending is not None and pending.args == NORMALISED and not expired


@pytest.mark.parametrize("mode_name", ["copilot", None])
async def test_confirm_executes_the_normalised_args_once(monkeypatch, mode_name):
    tools = teacher_tools()
    llm = FakeLLM([step_call("attendance_schedule_class", {"course": "DBMS", "when": "tomorrow 10am"})])
    await ask_for_confirmation(monkeypatch, tools, llm)
    llm_calls = len(llm.calls)

    payloads = await run("Confirm", mode_name=mode_name, request_id="r2")
    confirmed = [call for call in tools.calls if call[2]]
    assert confirmed == [("attendance_schedule_class", NORMALISED, True)]
    assert len(llm.calls) == llm_calls  # no LLM call on the confirm turn
    final = payloads[-1]
    assert final["header_message"] == "copilot:answer"
    assert final["response"] == SUMMARY
    assert final["data"]["source"] == "confirm"
    assert final["data"]["ui_actions"][0] == {"id": "tc1:1", "panel": "teacher.schedule", "params": {"sessionId": "s9"}}
    assert not any(p["header_message"].startswith("mode:switch") for p in payloads)
    assert copilot_session.store.has_pending(SID) is False


async def test_cancel_executes_nothing(monkeypatch):
    tools = teacher_tools()
    await ask_for_confirmation(monkeypatch, tools, FakeLLM([step_call("attendance_schedule_class", {"course": "DBMS"})]))
    before = len(tools.calls)
    payloads = await run("cancel", mode_name="copilot", request_id="r2")
    assert len(tools.calls) == before
    assert payloads[-1]["header_message"] == "copilot:answer"
    assert payloads[-1]["response"] == CANCELLED_TEXT
    assert copilot_session.store.has_pending(SID) is False


async def test_anything_else_drops_the_pending_action(monkeypatch):
    tools = teacher_tools()
    llm = FakeLLM([
        step_call("attendance_schedule_class", {"course": "DBMS", "when": "tomorrow 10am"}),
        step_text("Sure, which day should it move to?"),
    ])
    await ask_for_confirmation(monkeypatch, tools, llm)
    payloads = await run("yes but make it 11am", mode_name="copilot", request_id="r2")
    assert not any(call[2] for call in tools.calls)
    last_contents = llm.calls[-1]["contents"]
    assert last_contents[-1]["role"] == "user"
    assert "yes but make it 11am" in last_contents[-1]["parts"][0]["text"]
    assert payloads[-1]["header_message"] == "copilot:answer"
    assert copilot_session.store.has_pending(SID) is False


async def test_expired_confirmation(monkeypatch):
    now = [1000.0]
    copilot_session.store.set_clock(lambda: now[0])
    tools = teacher_tools()
    await ask_for_confirmation(monkeypatch, tools, FakeLLM([step_call("attendance_schedule_class", {"course": "DBMS"})]))
    now[0] += 601
    payloads = await run("yes", mode_name="copilot", request_id="r2")
    assert not any(call[2] for call in tools.calls)
    assert payloads[-1]["response"] == EXPIRED_TEXT
    assert copilot_session.store.has_pending(SID) is False


async def test_llm_cannot_set_confirmed(monkeypatch):
    seen = []

    def tool(args, confirmed):
        seen.append((dict(args), confirmed))
        return {"ok": True, "summary": "Ended."}

    tools = FakeCopilotTools(role="teacher", responses={"attendance_end_session": tool})
    install_copilot(monkeypatch, tools, FakeLLM([step_call("attendance_end_session", {"session": "s1", "confirmed": True})]))
    await run("end the class")
    assert seen == [({"session": "s1"}, False)]


async def test_planner_confirmation_round_trip(monkeypatch):
    tools = teacher_tools()
    install_copilot(monkeypatch, tools)  # LLM unavailable -> planner
    payloads = await run("Schedule DBMS class tomorrow at 10am for 90 minutes in LT-2")
    assert payloads[-1]["header_message"] == "copilot:confirm"
    assert tools.calls == [("attendance_schedule_class",
                            {"course": "DBMS", "when": "tomorrow at 10am", "durationMinutes": 90, "room": "LT-2"}, False)]
    payloads = await run("ok do it", mode_name="copilot", request_id="r2")
    assert tools.calls[-1] == ("attendance_schedule_class", NORMALISED, True)
    assert payloads[-1]["response"] == SUMMARY


async def test_routing_to_another_agent_clears_the_pending_action(monkeypatch):
    tools = FakeCopilotTools(role="student", responses={
        "attendance_join_course": needs_confirmation("attendance_join_course", {"joinCode": "K7M2QP"}, "Join CS301?"),
    })
    install_copilot(monkeypatch, tools)
    payloads = await run("join course with code K7M2QP", role="student")
    assert payloads[-1]["header_message"] == "copilot:confirm"
    assert copilot_session.store.has_pending(SID)
    payloads = await run("start a mock interview", mode_name="copilot", request_id="r2", role="student")
    assert payloads[0]["header_message"] == "mode:switch:ai-interviewer"
    assert copilot_session.store.has_pending(SID) is False


async def test_parallel_calls_keep_their_own_statuses(monkeypatch):
    tools = FakeCopilotTools(role="teacher", responses={
        "attendance_list_courses": {"ok": True, "summary": "You teach CS301 and DBMS."},
        "attendance_schedule_class": schedule_tool,
    })
    llm = FakeLLM([step_calls([("attendance_list_courses", {}), ("attendance_schedule_class", {"course": "DBMS", "when": "tomorrow 10am"})])])
    install_copilot(monkeypatch, tools, llm)
    payloads = await run("schedule DBMS tomorrow 10am")
    final = payloads[-1]
    assert final["header_message"] == "copilot:confirm"
    assert [c["status"] for c in final["data"]["tool_calls"]] == ["done", "needs_confirmation"]
    assert [c["id"] for c in final["data"]["tool_calls"]] == ["tc1", "tc2"]


@pytest.mark.parametrize("text,expected", [
    ("Confirm", "affirm"), ("yes please", "affirm"), ("ok do it", "affirm"), ("go ahead!", "affirm"),
    ("Cancel", "negative"), ("no thanks", "negative"), ("not now", "negative"), ("never mind", "negative"),
    ("yes but at 11am", None), ("yesterday", None), ("make sure the cgpa is 7", None),
    ("can you ensure salary is 10 LPA", None), ("Nokia", None), ("I don't know", None), ("Yes, post it", None),
])
def test_classify_reply_table(text, expected):
    assert classify_reply(text) == expected


def test_classify_reply_with_extra_phrases():
    assert classify_reply("Yes, post it", extra_affirmative=("post it",)) == "affirm"
    assert classify_reply("don't post", extra_negative=("don't post",)) == "negative"
    assert classify_reply("x" * 61) is None
