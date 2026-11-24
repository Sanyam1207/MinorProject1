"""The terminal-chunk invariant (PYTHON.md §2.4, §3.5): exactly one isEnd, last."""

import asyncio

import pytest

from fakes import FakeCopilotTools, FakeSio, install_copilot, make_req
from test_routing_roles import ROWS
from app import orchestrator
from app.agents import REGISTRY
from app.agents.base import AgentChunk
from app.agents.copilot.schemas import GENERIC_ERROR
from app.agents.jobscrapper import job_finder


class Chunk(AgentChunk):
    __slots__ = ("header_message", "response", "data", "is_end")

    def __init__(self, header, response, data=None, is_end=False):
        self.header_message = header
        self.response = response
        self.data = data if data is not None else {"type": "test"}
        self.is_end = is_end


class ScriptedAgent:
    """Yields the given items in order; exceptions are raised where they appear."""

    def __init__(self, name, items, *, owns=True, hang_after=None):
        self.name = name
        # Route like the real agent of that name.
        self.ROUTING_RULES = getattr(REGISTRY.get(name), "ROUTING_RULES", None)
        self.items = items
        self.emits_own_chunks = owns
        self.hang_after = hang_after
        self.started = asyncio.Event()

    @staticmethod
    def error_chunk(message, session_id=""):
        return Chunk("test:error", message, {"type": "error"}, True)

    async def run(self, req):
        for index, item in enumerate(self.items):
            if isinstance(item, BaseException):
                raise item
            yield item
            if self.hang_after == index:
                self.started.set()
                await asyncio.Event().wait()


def single_terminal(payloads):
    assert sum(1 for p in payloads if p.get("isEnd")) == 1
    assert payloads[-1]["isEnd"] is True


async def handle(text, **kw):
    sio = FakeSio()
    await orchestrator.handle(make_req(text, **kw), sio, "sid")
    return sio.payloads


async def test_router_failure_still_ends_the_request(monkeypatch):
    async def boom(req, role):
        raise RuntimeError("router exploded")

    monkeypatch.setattr(orchestrator, "resolve_mode", boom)
    payloads = await handle("hi")
    assert len(payloads) == 1
    assert payloads[0]["header_message"] == "copilot:error"
    assert payloads[0]["isEnd"] is True
    assert payloads[0]["response"] == GENERIC_ERROR
    assert payloads[0]["requestId"] == "r1"


async def test_broken_should_release_hook_releases(monkeypatch):
    class StubbornCopilot(ScriptedAgent):
        async def should_release(self, req, target=""):
            raise TypeError("bad signature")

    monkeypatch.setitem(REGISTRY, "copilot", StubbornCopilot("copilot", [Chunk("copilot:answer", "hi", is_end=True)]))
    monkeypatch.setitem(REGISTRY, "ai-interviewer", ScriptedAgent("ai-interviewer", [Chunk("interview:start", "Let's begin", is_end=True)]))
    payloads = await handle("start a mock interview", mode_name="copilot")
    assert payloads[0]["header_message"] == "mode:switch:ai-interviewer"
    assert payloads[-1]["header_message"] == "interview:start"
    single_terminal(payloads)


async def test_owning_agent_failure_uses_its_error_chunk(monkeypatch):
    monkeypatch.setitem(REGISTRY, "copilot", ScriptedAgent("copilot", [ValueError("secret detail")]))
    payloads = await handle("hi")
    single_terminal(payloads)
    assert payloads[-1]["header_message"] == "test:error"
    assert "secret detail" not in payloads[-1]["response"]


async def test_missing_terminal_chunk_is_completed(monkeypatch):
    monkeypatch.setitem(REGISTRY, "copilot", ScriptedAgent("copilot", [
        Chunk("copilot:thinking", "one"), Chunk("copilot:tool", "two", {"type": "copilot", "n": 2}),
    ]))
    payloads = await handle("hi")
    single_terminal(payloads)
    assert payloads[-1]["header_message"] == "copilot:tool"
    assert payloads[-1]["response"] == "two"
    assert payloads[-1]["data"] == {"type": "copilot", "n": 2}


async def test_agent_yielding_nothing_gets_a_terminal_error(monkeypatch):
    monkeypatch.setitem(REGISTRY, "copilot", ScriptedAgent("copilot", []))
    payloads = await handle("hi")
    assert len(payloads) == 1
    assert payloads[0]["header_message"] == "copilot:error"
    assert payloads[0]["isEnd"] is True


async def test_chunks_after_is_end_are_suppressed(monkeypatch):
    monkeypatch.setitem(REGISTRY, "copilot", ScriptedAgent("copilot", [
        Chunk("copilot:answer", "done", is_end=True), Chunk("copilot:tool", "late"), Chunk("copilot:answer", "again", is_end=True),
    ]))
    payloads = await handle("hi")
    assert [p["response"] for p in payloads] == ["done"]


async def test_non_owning_agent_failure_keeps_its_header(monkeypatch):
    monkeypatch.setitem(REGISTRY, "copilot", ScriptedAgent("copilot", ["partial text ", RuntimeError("boom")], owns=False))
    payloads = await handle("hi")
    single_terminal(payloads)
    assert payloads[-1]["header_message"] == "copilot:answer"
    assert payloads[-1]["response"] == "partial text "


async def test_cancellation_emits_nothing_more(monkeypatch):
    agent = ScriptedAgent("copilot", [Chunk("copilot:thinking", "…")], hang_after=0)
    monkeypatch.setitem(REGISTRY, "copilot", agent)
    sio = FakeSio()
    task = asyncio.create_task(orchestrator.handle(make_req("hi"), sio, "sid"))
    await asyncio.wait_for(agent.started.wait(), 2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert [p["header_message"] for p in sio.payloads] == ["copilot:thinking"]
    assert not any(p.get("isEnd") for p in sio.payloads)


@pytest.mark.parametrize("role,mode_name,text,expected,switch,extra", ROWS)
async def test_mode_none_is_never_emitted(monkeypatch, role, mode_name, text, expected, switch, extra):
    monkeypatch.setattr(job_finder, "is_safe_url", lambda url: False)  # no DNS lookups in tests
    install_copilot(monkeypatch, FakeCopilotTools(role=role))
    payloads = await handle(text, role=role, mode_name=mode_name)
    assert "mode:none" not in [p["header_message"] for p in payloads]
    single_terminal(payloads)
