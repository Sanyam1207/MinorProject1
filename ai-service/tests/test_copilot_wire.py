"""Copilot wire format and LLM tool loop (AGENT-TOOLS.md §6, PYTHON.md §5.2/§5.7)."""

import json

from fakes import (
    FakeCopilotTools, FakeLLM, FakeSio, install_copilot, make_req, step_call, step_text,
)
from app import orchestrator
from app.agents.copilot.llm import CopilotLLMError, LLMStep
from app.agents.copilot.schemas import BLOCKED_TEXT, NO_TOOLS_TEXT, UNREACHABLE_TEXT
from app.config import settings

COPILOT_HEADERS = {"copilot:thinking", "copilot:tool", "copilot:answer", "copilot:confirm", "copilot:error"}


async def run(text, *, role="student", with_tools=True, request_id="r1", **meta):
    sio = FakeSio()
    await orchestrator.handle(
        make_req(text, role=role, mode_name="copilot", request_id=request_id, with_tools=with_tools, **meta), sio, "sid"
    )
    return sio.payloads


def assert_wire(payloads):
    assert payloads, "nothing emitted"
    terminal = [p for p in payloads if p.get("isEnd")]
    assert len(terminal) == 1 and payloads[-1]["isEnd"] is True
    for payload in payloads:
        assert payload["header_message"] in COPILOT_HEADERS, payload["header_message"]
        assert payload["data"]["type"] == "copilot"
        assert payload["requestId"]
        if not payload["isEnd"]:
            assert payload["response"].strip()


async def test_ui_actions_are_cumulative_ordered_and_unique(monkeypatch):
    tools = FakeCopilotTools(role="student", responses={
        "attendance_my_summary": {"ok": True, "summary": "82% overall.", "ui": {"panel": "attendance.student", "params": {}}},
        "applications_list": {"ok": True, "summary": "2 applications.", "ui": [
            {"panel": "applications", "params": {"status": "applied"}},
            {"panel": "offers", "params": {}, "data": {"note": "x"}},
            {"params": {"missing": "panel"}},
        ]},
    })
    llm = FakeLLM([
        step_call("attendance_my_summary", {}),
        step_call("applications_list", {"status": "applied"}),
        step_text("Here you go."),
    ])
    install_copilot(monkeypatch, tools, llm)
    payloads = await run("show my attendance and applications")
    assert_wire(payloads)

    previous: list = []
    for payload in payloads:
        actions = payload["data"]["ui_actions"]
        assert actions[: len(previous)] == previous  # cumulative, order kept
        previous = actions
    ids = [action["id"] for action in previous]
    assert ids == ["tc1:1", "tc2:1", "tc2:2"]
    assert previous[2] == {"id": "tc2:2", "panel": "offers", "params": {}, "data": {"note": "x"}}
    tool_chunks = [p for p in payloads if p["header_message"] == "copilot:tool"]
    assert any(a["id"] == "tc1:1" for p in tool_chunks for a in p["data"]["ui_actions"])  # streamed before the answer
    assert payloads[-1]["response"] == "Here you go."
    assert payloads[-1]["data"]["phase"] == "answer"


async def test_round_cap_then_forced_text(monkeypatch):
    tools = FakeCopilotTools(role="student", responses={"notifications_list": {"ok": True, "summary": "ok"}})
    llm = FakeLLM([lambda index: step_call("notifications_list", {"page": index})], repeat_last=True)
    install_copilot(monkeypatch, tools, llm)
    payloads = await run("check my notifications")
    assert_wire(payloads)
    rounds = settings.COPILOT_MAX_TOOL_ROUNDS
    assert len(tools.calls) == rounds
    assert len(llm.calls) == rounds + 1
    assert [call["force_text"] for call in llm.calls] == [False] * rounds + [True]
    assert payloads[-1]["header_message"] == "copilot:answer"


async def test_tool_validation_error_is_fed_back(monkeypatch):
    tools = FakeCopilotTools(role="teacher", responses={
        "attendance_course_report": {"ok": False, "error": "VALIDATION", "message": "course is required"},
    })
    llm = FakeLLM([step_call("attendance_course_report", {}), step_text("Which course do you mean?")])
    install_copilot(monkeypatch, tools, llm)
    payloads = await run("course report please", role="teacher")
    assert_wire(payloads)
    call = payloads[-1]["data"]["tool_calls"][0]
    assert call["status"] == "error" and call["error"] == "VALIDATION"
    response_part = llm.calls[1]["contents"][-1]["parts"][0]["functionResponse"]
    assert response_part["name"] == "attendance_course_report"
    assert response_part["response"] == {"ok": False, "error": "VALIDATION", "message": "course is required"}


async def test_no_tool_token_means_no_calls(monkeypatch):
    tools = FakeCopilotTools()
    llm = FakeLLM([step_call("attendance_my_summary", {})])
    install_copilot(monkeypatch, tools, llm)
    payloads = await run("show my attendance", with_tools=False)
    assert_wire(payloads)
    assert payloads[-1]["response"] == NO_TOOLS_TEXT
    assert tools.calls == [] and tools.manifest_calls == 0 and llm.calls == []


async def test_manifest_unavailable_is_a_terminal_error(monkeypatch):
    install_copilot(monkeypatch, FakeCopilotTools(manifest_error="UNAVAILABLE"), FakeLLM())
    payloads = await run("show my attendance")
    assert_wire(payloads)
    assert payloads[-1]["header_message"] == "copilot:error"
    assert payloads[-1]["response"] == UNREACHABLE_TEXT
    assert payloads[-1]["data"]["message"] == UNREACHABLE_TEXT


async def test_llm_error_in_round_one_uses_the_planner(monkeypatch):
    tools = FakeCopilotTools(role="student", responses={"attendance_my_summary": {"ok": True, "summary": "82% overall."}})
    llm = FakeLLM([CopilotLLMError("HTTP 500")])
    install_copilot(monkeypatch, tools, llm)
    payloads = await run("what's my attendance")
    assert_wire(payloads)
    assert payloads[-1]["data"]["source"] == "planner"
    assert payloads[-1]["response"] == "82% overall."
    assert tools.calls == [("attendance_my_summary", {}, False)]


async def test_llm_error_after_a_tool_ran_answers_from_summaries(monkeypatch):
    tools = FakeCopilotTools(role="student", responses={"attendance_my_summary": {"ok": True, "summary": "82% overall."}})
    llm = FakeLLM([step_call("attendance_my_summary", {}), CopilotLLMError("timeout")])
    install_copilot(monkeypatch, tools, llm)
    payloads = await run("what's my attendance")
    assert_wire(payloads)
    assert payloads[-1]["response"] == "82% overall."
    assert len(tools.calls) == 1


async def test_blocked_response(monkeypatch):
    llm = FakeLLM([LLMStep(text="", calls=[], model_content=None, finish_reason="SAFETY", blocked=True)])
    install_copilot(monkeypatch, FakeCopilotTools(), llm)
    payloads = await run("something unpleasant")
    assert_wire(payloads)
    assert payloads[-1]["response"] == BLOCKED_TEXT


async def test_hallucinated_tool_is_never_sent(monkeypatch):
    tools = FakeCopilotTools(role="student")
    llm = FakeLLM([step_call("delete_all_students", {"really": True}), step_text("I can't do that.")])
    install_copilot(monkeypatch, tools, llm)
    payloads = await run("delete everyone")
    assert_wire(payloads)
    assert tools.calls == []
    fed_back = llm.calls[1]["contents"][-1]["parts"][0]["functionResponse"]["response"]
    assert fed_back["ok"] is False and fed_back["error"] == "UNKNOWN_TOOL"
    assert payloads[-1]["data"]["tool_calls"][0]["error"] == "UNKNOWN_TOOL"


async def test_identical_repeated_call_runs_once(monkeypatch):
    tools = FakeCopilotTools(role="student", responses={"offers_list": {"ok": True, "summary": "No offers yet."}})
    llm = FakeLLM([step_call("offers_list", {}), step_call("offers_list", {}), step_text("No offers yet.")])
    install_copilot(monkeypatch, tools, llm)
    payloads = await run("any offers?")
    assert_wire(payloads)
    assert len(tools.calls) == 1
    assert len(payloads[-1]["data"]["tool_calls"]) == 2


async def test_model_content_is_passed_back_verbatim(monkeypatch):
    tools = FakeCopilotTools(role="student", responses={"offers_list": {"ok": True, "summary": "No offers yet."}})
    first = step_call("offers_list", {}, call_id="call-7", extra_part={"thoughtSignature": "c2lnbmF0dXJl"})
    llm = FakeLLM([first, step_text("No offers.")])
    install_copilot(monkeypatch, tools, llm)
    await run("any offers?")
    contents = llm.calls[1]["contents"]
    assert contents[-2] == first.model_content
    assert contents[-2]["parts"][0]["thoughtSignature"] == "c2lnbmF0dXJl"
    response_part = contents[-1]["parts"][0]["functionResponse"]
    assert response_part["id"] == "call-7"
    assert response_part["response"]["ok"] is True


async def test_system_prompt_has_no_secrets(monkeypatch):
    llm = FakeLLM([step_text("Hello!")])
    install_copilot(monkeypatch, FakeCopilotTools(role="teacher"), llm)
    await run("hello", role="teacher", ui_context={"panel": "teacher.live", "params": {"sessionId": "s1", "note": "x"}})
    system = llm.calls[0]["system"]
    assert "test-tool-token" not in system
    assert "tools.invalid" not in system
    assert "@example.invalid" not in system
    assert "Test User" in system and "teacher" in system
    assert "sessionId: s1" in system
    assert "Asia/Kolkata" in system


async def test_large_results_are_truncated_for_the_llm(monkeypatch):
    monkeypatch.setattr(settings, "COPILOT_TOOL_RESULT_MAX_CHARS", 300)
    big = {"rows": ["x" * 50] * 40}
    tools = FakeCopilotTools(role="student", responses={"applications_list": {"ok": True, "summary": "40 rows.", "data": big}})
    llm = FakeLLM([step_call("applications_list", {}), step_text("Done.")])
    install_copilot(monkeypatch, tools, llm)
    await run("my applications")
    response = llm.calls[1]["contents"][-1]["parts"][0]["functionResponse"]["response"]
    assert response["data_truncated"] is True
    assert len(response["data_preview"]) == 300
    assert "data" not in response
    assert json.dumps(big)[:300] == response["data_preview"]


async def test_ambiguous_result_offers_the_candidates(monkeypatch):
    tools = FakeCopilotTools(role="teacher", responses={
        "attendance_start_session": {"ok": False, "error": "AMBIGUOUS", "message": "Which CS301 section?",
                                     "candidates": [{"id": "k1", "label": "CS301 · Sec A"}, {"id": "k2", "label": "CS301 · Sec B"}]},
    })
    install_copilot(monkeypatch, tools)  # planner path
    payloads = await run("start attendance for CS301", role="teacher")
    assert_wire(payloads)
    final = payloads[-1]
    assert final["options"] == ["CS301 · Sec A", "CS301 · Sec B"]
    assert "1. CS301 · Sec A" in final["response"] and "Reply with the number or name." in final["response"]

    tools.responses["attendance_start_session"] = {"ok": True, "summary": "Attendance is live.",
                                                   "ui": {"panel": "teacher.live", "params": {"sessionId": "s2"}}}
    payloads = await run("2", role="teacher", request_id="r2")
    assert tools.calls[-1] == ("attendance_start_session", {"course": "k2"}, False)
    assert payloads[-1]["response"] == "Attendance is live."
