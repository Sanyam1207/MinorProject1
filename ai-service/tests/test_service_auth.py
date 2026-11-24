"""Socket hardening (PYTHON.md §2): shared-secret auth, loopback bind, CORS, cancellation."""

import asyncio

import httpx
import pytest
import socketio

from app import main
from app.config import Settings, settings


async def test_connect_requires_the_shared_token(monkeypatch):
    monkeypatch.setattr(settings, "AI_SERVICE_TOKEN", "s3cret")
    await main.connect("s1", {}, {"token": "s3cret"})
    for bad in ({"token": "wrong"}, None, "s3cret", {"token": None}, {}):
        with pytest.raises(socketio.exceptions.ConnectionRefusedError):
            await main.connect("s2", {}, bad)


async def test_connect_is_open_without_a_configured_token(monkeypatch):
    monkeypatch.setattr(settings, "AI_SERVICE_TOKEN", "")
    await main.connect("s1", {}, None)
    await main.connect("s1", {}, {"token": "anything"})


async def test_disconnect_cancels_the_connections_tasks(monkeypatch):
    started = asyncio.Event()

    async def slow_handle(req, sio, sid):
        started.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(main, "handle", slow_handle)
    await main.on_query("sid-x", {"requestId": "r1", "sessionId": "u1:s1", "user_query": "hi"})
    await asyncio.wait_for(started.wait(), 2)
    task = next(iter(main._TASKS_BY_SID["sid-x"]))
    await main.disconnect("sid-x", "transport close")
    with pytest.raises(asyncio.CancelledError):
        await task
    assert task.cancelled()
    assert "sid-x" not in main._TASKS_BY_SID
    assert task not in main._INFLIGHT


async def test_invalid_payload_gets_a_terminal_answer(monkeypatch):
    sent = []

    async def fake_emit(event, payload, to=None):
        sent.append((event, payload, to))

    monkeypatch.setattr(main.sio, "emit", fake_emit)
    await main.on_query("sid-y", {"requestId": "r9"})
    assert sent == [("response", {"requestId": "r9", "header_message": "invalid request", "response": "", "isEnd": True}, "sid-y")]


def test_default_bind_is_loopback(monkeypatch):
    monkeypatch.delenv("AI_HOST", raising=False)
    assert Settings().AI_HOST == "127.0.0.1"


def test_cors_origins(monkeypatch):
    monkeypatch.setenv("AI_CORS_ORIGINS", "")
    assert Settings().cors_allowed_origins() is None
    monkeypatch.setenv("AI_CORS_ORIGINS", "*")
    assert Settings().cors_allowed_origins() is None
    monkeypatch.setenv("AI_CORS_ORIGINS", " https://a.example , *, https://b.example/ ")
    assert Settings().cors_allowed_origins() == ["https://a.example", "https://b.example"]


def test_socket_server_limits():
    assert main.sio.eio.max_http_buffer_size == 10_000_000
    assert main.sio.eio.cors_allowed_origins is None


async def test_health_reveals_nothing():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.api), base_url="http://test") as client:
        response = await client.get("/health")
        assert response.status_code == 200 and response.json() == {"ok": True}
        assert (await client.get("/docs")).status_code == 404
        assert (await client.get("/openapi.json")).status_code == 404
