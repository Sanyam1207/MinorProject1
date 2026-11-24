"""Node tool API client (PYTHON.md §5.4, JOB-FEED.md §12.3)."""

import json

import httpx
import pytest

from fakes import make_req
from app import tools_client
from app.agents.copilot.tools_client import CopilotTools, ToolResult, ToolsUnavailable, clear_manifest_cache

META = make_req("x").meta_data


def serve(monkeypatch, handler):
    requests = []

    def record(request):
        requests.append(request)
        return handler(request, len(requests))

    monkeypatch.setattr(tools_client, "_TRANSPORT", httpx.MockTransport(record))
    return requests


async def test_execute_sends_bearer_and_unwraps_the_envelope(monkeypatch):
    inner = {"ok": True, "tool": "offers_list", "summary": "No offers.", "data": {"offers": []}}
    requests = serve(monkeypatch, lambda req, n: httpx.Response(
        200, json={"statusCode": 200, "data": inner, "message": "ok", "success": True}))
    result = await tools_client.execute_tool(META, "offers_list", {"a": 1}, request_id="r1")
    assert result == inner
    request = requests[0]
    assert str(request.url) == "http://tools.invalid/api/v1/agent-tools/execute"
    assert request.headers["authorization"] == "Bearer test-tool-token"
    assert request.headers["x-request-id"] == "r1"
    assert json.loads(request.content) == {"tool": "offers_list", "args": {"a": 1}}

    await tools_client.execute_tool(META, "offers_list", {}, confirmed=True)
    assert json.loads(requests[1].content)["confirmed"] is True


async def test_raw_bodies_are_accepted(monkeypatch):
    serve(monkeypatch, lambda req, n: httpx.Response(200, json={"ok": False, "error": "AMBIGUOUS", "message": "Which?",
                                                                 "candidates": [{"id": "k1", "label": "A"}]}))
    result = await tools_client.execute_tool(META, "drive_apply", {"job": "x"})
    assert result["error"] == "AMBIGUOUS"
    tool_result = ToolResult.from_payload("drive_apply", result)
    assert tool_result.candidates == [{"id": "k1", "label": "A"}] and tool_result.ok is False


@pytest.mark.parametrize("status,code", [(401, "AUTH"), (403, "AUTH"), (404, "UNAVAILABLE"), (429, "UNAVAILABLE"),
                                         (503, "UNAVAILABLE"), (418, "INTERNAL")])
async def test_status_mapping(monkeypatch, status, code):
    serve(monkeypatch, lambda req, n: httpx.Response(status, json={"success": False, "message": "nope", "data": None}))
    result = await tools_client.execute_tool(META, "offers_list", {})
    assert result["ok"] is False and result["error"] == code
    assert "test-tool-token" not in json.dumps(result)


async def test_transport_failures(monkeypatch):
    def timeout(request, n):
        raise httpx.ReadTimeout("slow", request=request)

    serve(monkeypatch, timeout)
    assert (await tools_client.execute_tool(META, "offers_list", {}))["error"] == "UNAVAILABLE"
    serve(monkeypatch, lambda req, n: httpx.Response(200, text="<html>"))
    assert (await tools_client.execute_tool(META, "offers_list", {}))["error"] == "INTERNAL"
    assert (await tools_client.execute_tool({}, "offers_list", {}))["error"] == "NO_TOOL_TOKEN"
    assert tools_client.has_tool_access(META) is True
    assert tools_client.has_tool_access({"tool_token": "t", "tools_url": "ftp://x"}) is False


async def test_manifest_retries_once_and_caches(monkeypatch):
    clear_manifest_cache()

    def handler(request, n):
        if n == 1:
            return httpx.Response(502)
        return httpx.Response(200, json={"success": True, "statusCode": 200, "message": "ok", "data": {
            "role": "student", "tools": [{"name": "offers_list", "description": "List offers.", "parameters": None, "confirm": False}],
        }})

    requests = serve(monkeypatch, handler)
    tools = CopilotTools(META, request_id="r1")
    manifest = await tools.manifest("student")
    assert manifest.names == {"offers_list"}
    assert len(requests) == 2
    again = await CopilotTools(META, request_id="r2").manifest("student")
    assert again is manifest and len(requests) == 2  # cached per (tools_url, role)


async def test_manifest_and_execute_raise_on_transport_errors(monkeypatch):
    clear_manifest_cache()
    serve(monkeypatch, lambda req, n: httpx.Response(401))
    tools = CopilotTools(META, request_id="r1")
    with pytest.raises(ToolsUnavailable) as caught:
        await tools.manifest("student")
    assert caught.value.code == "AUTH"
    with pytest.raises(ToolsUnavailable):
        await tools.execute("offers_list", {})
    serve(monkeypatch, lambda req, n: httpx.Response(200, json={"ok": False, "error": "VALIDATION", "message": "bad"}))
    result = await tools.execute("offers_list", {})
    assert result.ok is False and result.error == "VALIDATION"
