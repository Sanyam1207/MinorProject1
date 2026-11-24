"""Shared Gemini client (PYTHON.md §4) and the key-hygiene acceptance checks."""

import json
import logging
import re
from pathlib import Path

import httpx
import pytest

from app.agents.copilot.llm import (
    CopilotLLMError, GeminiCopilotLLM, history_to_contents, manifest_to_function_declarations, to_gemini_schema,
)
from app.agents.copilot.tools_client import Manifest
from app.config import settings
from app.llm import gemini
from app.logging_setup import RedactingFilter, redact
from app.schemas import PastMessage

APP_DIR = Path(__file__).resolve().parents[1] / "app"
KEY = "test-key-123"


@pytest.fixture
def keyed(monkeypatch):
    monkeypatch.setattr(settings, "GEMINI_API_KEY", KEY)
    monkeypatch.setattr(settings, "GEMINI_MODEL", "gemini-test")
    waits = []

    async def fake_sleep(seconds):
        waits.append(seconds)

    monkeypatch.setattr(gemini, "_sleep", fake_sleep)
    return waits


def transport(monkeypatch, handler):
    requests = []

    def record(request):
        requests.append(request)
        return handler(request, len(requests))

    monkeypatch.setattr(gemini, "_TRANSPORT", httpx.MockTransport(record))
    return requests


def ok_body(parts, finish="STOP", **extra):
    return {"candidates": [{"content": {"role": "model", "parts": parts}, "finishReason": finish}], **extra}


async def test_generate_sends_the_key_only_in_a_header(monkeypatch, keyed):
    requests = transport(monkeypatch, lambda req, n: httpx.Response(200, json=ok_body([{"text": "hi"}])))
    response = await gemini.generate(
        contents=[gemini.user_turn("hello")],
        system="be brief",
        tools=[{"functionDeclarations": [{"name": "offers_list", "description": "List offers"}]}],
        tool_config={"functionCallingConfig": {"mode": "AUTO"}},
        generation_config={"temperature": 0.2},
    )
    assert response.text == "hi"
    request = requests[0]
    assert str(request.url) == "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent"
    assert request.url.query == b""
    assert "key=" not in str(request.url)
    assert request.headers["x-goog-api-key"] == KEY
    body = json.loads(request.content)
    assert body["contents"][0]["parts"][0]["text"] == "hello"
    assert body["systemInstruction"] == {"parts": [{"text": "be brief"}]}
    assert body["tools"][0]["functionDeclarations"][0]["name"] == "offers_list"
    assert body["toolConfig"]["functionCallingConfig"]["mode"] == "AUTO"
    assert body["generationConfig"] == {"temperature": 0.2}


async def test_stream_text_uses_sse(monkeypatch, keyed):
    sse = (
        'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}\n\n'
        'data: {"candidates":[{"content":{"parts":[{"text":"thinking...","thought":true},{"text":"lo"}]}}]}\n\n'
        "data: [DONE]\n\n"
    )
    requests = transport(monkeypatch, lambda req, n: httpx.Response(200, text=sse, headers={"content-type": "text/event-stream"}))
    chunks = [chunk async for chunk in gemini.stream_text(contents=[gemini.user_turn("hi")])]
    assert chunks == ["Hel", "lo"]
    assert str(requests[0].url).endswith(":streamGenerateContent?alt=sse")
    assert requests[0].headers["x-goog-api-key"] == KEY


async def test_parts_are_parsed_without_indexing_blindly(monkeypatch, keyed):
    parts = [
        {"text": "Let me check. "},
        {"functionCall": {"name": "offers_list", "args": {"status": "pending"}}, "thoughtSignature": "sig=="},
        {"text": "private reasoning", "thought": True},
        {"functionCall": {"name": "training_list"}},
    ]
    transport(monkeypatch, lambda req, n: httpx.Response(200, json=ok_body(parts)))
    response = await gemini.generate(contents=[gemini.user_turn("x")])
    assert response.text == "Let me check. "
    assert [(c.name, c.args) for c in response.function_calls] == [("offers_list", {"status": "pending"}), ("training_list", {})]
    assert response.content == {"role": "model", "parts": parts}
    assert response.content["parts"][1]["thoughtSignature"] == "sig=="


async def test_rate_limit_waits_for_retry_delay(monkeypatch, keyed):
    def handler(request, n):
        if n == 1:
            return httpx.Response(429, json={"error": {"message": "slow down", "details": [{"retryDelay": "1s"}]}})
        return httpx.Response(200, json=ok_body([{"text": "ok"}]))

    requests = transport(monkeypatch, handler)
    response = await gemini.generate(contents=[gemini.user_turn("x")])
    assert response.text == "ok"
    assert len(requests) == 2
    assert keyed and keyed[0] >= 1


async def test_server_errors_give_up_after_three_attempts(monkeypatch, keyed):
    requests = transport(monkeypatch, lambda req, n: httpx.Response(503, json={"error": {"message": "busy"}}))
    with pytest.raises(gemini.GeminiError) as caught:
        await gemini.generate(contents=[gemini.user_turn("x")])
    assert len(requests) == 3
    assert caught.value.status == 503
    assert await gemini.generate_text(contents=[gemini.user_turn("x")]) is None  # soft helper never raises


async def test_client_errors_are_not_retried(monkeypatch, keyed):
    requests = transport(monkeypatch, lambda req, n: httpx.Response(400, json={"error": {"message": "bad request"}}))
    with pytest.raises(gemini.GeminiError) as caught:
        await gemini.generate(contents=[gemini.user_turn("x")])
    assert len(requests) == 1
    assert KEY not in str(caught.value)


async def test_blocked_responses(monkeypatch, keyed):
    transport(monkeypatch, lambda req, n: httpx.Response(200, json=ok_body([{"text": "partial"}], finish="SAFETY")))
    assert (await gemini.generate(contents=[gemini.user_turn("x")])).blocked is True
    transport(monkeypatch, lambda req, n: httpx.Response(200, json={"promptFeedback": {"blockReason": "OTHER"}}))
    response = await gemini.generate(contents=[gemini.user_turn("x")])
    assert response.blocked is True and response.content is None
    assert await gemini.generate_text(contents=[gemini.user_turn("x")]) is None


async def test_generate_json_parses_fenced_objects(monkeypatch, keyed):
    transport(monkeypatch, lambda req, n: httpx.Response(200, json=ok_body([{"text": '```json\n{"a": 1}\n```'}])))
    assert await gemini.generate_json(contents=[gemini.user_turn("x")]) == {"a": 1}
    transport(monkeypatch, lambda req, n: httpx.Response(200, json=ok_body([{"text": "[1, 2]"}])))
    assert await gemini.generate_json(contents=[gemini.user_turn("x")]) is None


async def test_empty_key_makes_no_request(monkeypatch):
    monkeypatch.setattr(settings, "GEMINI_API_KEY", "")
    requests = transport(monkeypatch, lambda req, n: httpx.Response(200, json=ok_body([{"text": "x"}])))
    with pytest.raises(gemini.GeminiNotConfigured):
        await gemini.generate(contents=[gemini.user_turn("x")])
    with pytest.raises(gemini.GeminiNotConfigured):
        async for _ in gemini.stream_text(contents=[gemini.user_turn("x")]):
            pass
    assert await gemini.generate_json(contents=[gemini.user_turn("x")]) is None
    assert requests == []
    assert gemini.is_configured() is False and gemini.is_configured("abc") is True


async def test_copilot_llm_step(monkeypatch, keyed):
    requests = transport(monkeypatch, lambda req, n: httpx.Response(200, json=ok_body([{"functionCall": {"name": "offers_list", "args": {}}}])))
    llm = GeminiCopilotLLM()
    assert llm.available is True
    step = await llm.step(system="s", contents=[gemini.user_turn("x")], declarations=[{"name": "offers_list", "description": "d"}], force_text=True)
    assert [c.name for c in step.calls] == ["offers_list"]
    assert json.loads(requests[0].content)["toolConfig"]["functionCallingConfig"]["mode"] == "NONE"

    transport(monkeypatch, lambda req, n: httpx.Response(200, json=ok_body([], finish="MALFORMED_FUNCTION_CALL")))
    with pytest.raises(CopilotLLMError):
        await llm.step(system="s", contents=[gemini.user_turn("x")], declarations=[])


def test_http_logging_is_quiet():
    assert logging.getLogger("httpx").level == logging.WARNING
    assert logging.getLogger("httpcore").level == logging.WARNING


def test_redaction(monkeypatch):
    monkeypatch.setattr(settings, "GEMINI_API_KEY", "AIzaSyTESTKEY000")
    monkeypatch.setattr(settings, "AI_SERVICE_TOKEN", "service-token-xyz")
    text = ("calling https://x.test/v1?alt=sse&key=abc123 with AIzaSyTESTKEY000, Authorization: Bearer eyJ.abc-def_1, "
            "token service-token-xyz, x-goog-api-key: zzz999")
    cleaned = redact(text)
    for secret in ("abc123", "AIzaSyTESTKEY000", "eyJ.abc-def_1", "service-token-xyz", "zzz999"):
        assert secret not in cleaned
    record = logging.LogRecord("t", logging.INFO, __file__, 1, "key is %s", ("AIzaSyTESTKEY000",), None)
    RedactingFilter().filter(record)
    assert record.getMessage() == "key is ***"


def test_to_gemini_schema_rules():
    schema = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "course": {"type": "string", "description": "Course code", "default": "x"},
            "mode": {"type": "string", "enum": ["auto", "manual"]},
            "days": {"type": ["integer", "null"]},
            "level": {"type": "integer", "enum": [1, 2]},
            "tags": {"type": "array"},
            "params": {"type": "object"},
            "weird": {"type": "uuid"},
        },
        "required": ["course", "params", "ghost"],
    }
    out = to_gemini_schema(schema)
    assert out["type"] == "OBJECT"
    assert "additionalProperties" not in out
    props = out["properties"]
    assert props["course"] == {"type": "STRING", "description": "Course code"}
    assert props["mode"] == {"type": "STRING", "enum": ["auto", "manual"], "format": "enum"}
    assert props["days"] == {"type": "INTEGER", "nullable": True}
    assert props["level"]["type"] == "INTEGER" and "enum" not in props["level"]
    assert props["level"]["description"].endswith("Allowed values: 1, 2")
    assert props["tags"] == {"type": "ARRAY", "items": {"type": "STRING"}}
    assert "params" not in props
    assert props["weird"]["type"] == "STRING"
    assert out["required"] == ["course"]


def test_manifest_declarations():
    manifest = Manifest.from_payload("student", [
        {"name": "offers_list", "description": "List offers.", "parameters": {"type": "object", "properties": {}}},
        {"name": "open_panel", "description": "Open a panel.", "parameters": {"type": "object", "properties": {
            "panel": {"type": "string", "enum": ["offers"]}, "params": {"type": "object"}}, "required": ["panel"]}},
        {"name": "Bad Name", "description": "skipped"},
    ])
    declarations = manifest_to_function_declarations(manifest)
    assert declarations[0] == {"name": "offers_list", "description": "List offers."}
    assert declarations[1]["parameters"]["properties"] == {"panel": {"type": "STRING", "enum": ["offers"], "format": "enum"}}
    assert len(declarations) == 2


def test_history_to_contents():
    past = [
        PastMessage(role="assistant", content="Welcome!"),
        PastMessage(role="user", content="hi"),
        PastMessage(role="user", content="are you there"),
        PastMessage(role="assistant", content="Yes."),
        PastMessage(role="assistant", content="  "),
        PastMessage(role="user", content="show my offers"),
    ]
    contents = history_to_contents(past, "show my offers")
    assert [c["role"] for c in contents] == ["user", "model", "user"]
    assert contents[0]["parts"][0]["text"] == "hi\n\nare you there"
    assert contents[-1]["parts"][0]["text"] == "show my offers"
    assert history_to_contents(None, "x") == [{"role": "user", "parts": [{"text": "x"}]}]


def test_no_key_in_urls():
    offenders = []
    for path in APP_DIR.rglob("*.py"):
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if re.search(r"[?&]key=|key=\{settings", line):
                offenders.append(f"{path.relative_to(APP_DIR)}:{number}")
    assert offenders == []


def test_no_event_loop_policy_or_get_event_loop():
    browser = (APP_DIR / "agents" / "jobscrapper" / "scraper" / "browser.py").read_text(encoding="utf-8")
    assert "set_event_loop_policy" not in browser
    for path in APP_DIR.rglob("*.py"):
        source = path.read_text(encoding="utf-8")
        assert "get_event_loop(" not in source, path
        assert "set_event_loop_policy" not in source, path
