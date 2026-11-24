"""Shared pytest setup for the agent service.

Tests never touch the network: no Gemini key is configured, both HTTP clients
(Gemini and the Node tool API) get a transport that refuses every request, and
the Node tool API is always faked. The environment is pinned BEFORE ``app`` is
imported (``load_dotenv`` never overrides variables that are already set), so a
developer's ``.env`` cannot change test behaviour.
"""

import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_PINNED_ENV = {
    "GEMINI_API_KEY": "",
    "AI_SERVICE_TOKEN": "",
    "AI_CORS_ORIGINS": "",
    "COPILOT_MODEL": "",
    "COPILOT_MAX_TOOL_ROUNDS": "6",
    "COPILOT_CONFIRM_TTL_SECONDS": "600",
    "GEMINI_BASE_URL": "https://generativelanguage.googleapis.com",
    "LOG_LEVEL": "INFO",
}
os.environ.update(_PINNED_ENV)

import httpx  # noqa: E402
import pytest  # noqa: E402

from app import tools_client  # noqa: E402
from app.agents.copilot import session as copilot_session  # noqa: E402
from app.agents.copilot.tools_client import clear_manifest_cache  # noqa: E402
from app.agents.jobscrapper.session_store import session_job_store  # noqa: E402
from app.agents.job_creator import session as job_creator_session  # noqa: E402
from app.agents.job_eligibility import session as eligibility_session  # noqa: E402
from app.llm import gemini  # noqa: E402


def _network_disabled(request: httpx.Request) -> httpx.Response:
    raise httpx.ConnectError("network disabled in tests", request=request)


def _reset_state() -> None:
    copilot_session.store.reset()
    copilot_session.store.set_clock(time.monotonic)
    clear_manifest_cache()
    session_job_store.clear()
    job_creator_session._SESSIONS.clear()
    eligibility_session._SESSIONS.clear()


@pytest.fixture(autouse=True)
def _isolated(monkeypatch):
    """Fresh in-memory state and no real HTTP for every test."""
    monkeypatch.setattr(gemini, "_TRANSPORT", httpx.MockTransport(_network_disabled))
    monkeypatch.setattr(tools_client, "_TRANSPORT", httpx.MockTransport(_network_disabled))
    _reset_state()
    yield
    _reset_state()
