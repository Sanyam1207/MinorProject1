"""Runtime configuration for the agent service.

Every value comes from the environment (``.env`` is loaded once, at import,
and never overrides variables that are already set). ``Settings`` reads the
environment in ``__init__`` so ``Settings()`` built inside a test reflects the
current environment, and every module reads ``settings.X`` at call time --
never a module-level constant -- so tests can ``monkeypatch.setattr``.

No secret has a non-empty default.
"""

from __future__ import annotations

import logging
import os
from typing import List, Optional

from dotenv import load_dotenv

load_dotenv()

_VALID_LOG_LEVELS = {"CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG"}


def _env_str(name: str, default: str = "") -> str:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip()


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(float(raw.strip()))
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        return float(raw.strip())
    except ValueError:
        return default


class Settings:
    """Runtime config. Everything overridable through environment variables."""

    def __init__(self) -> None:
        # -- process / transport -------------------------------------------
        self.AI_HOST: str = _env_str("AI_HOST", "127.0.0.1") or "127.0.0.1"
        self.AI_PORT: int = _env_int("AI_PORT", 9000)
        # Shared secret with Node (backend AI_SERVICE_TOKEN). Empty = open
        # (local development only).
        self.AI_SERVICE_TOKEN: str = _env_str("AI_SERVICE_TOKEN", "")
        # Comma list of browser origins allowed to open a socket. Normally
        # empty: only the Node backend (which sends no Origin) connects.
        self.AI_CORS_ORIGINS: str = _env_str("AI_CORS_ORIGINS", "")
        level = _env_str("LOG_LEVEL", "INFO").upper()
        self.LOG_LEVEL: str = level if level in _VALID_LOG_LEVELS else "INFO"
        # Unused (kept for compatibility with old .env files).
        self.STREAM_DELAY: float = _env_float("STREAM_DELAY", 0.08)

        # -- Gemini ----------------------------------------------------------
        self.GEMINI_API_KEY: str = _env_str("GEMINI_API_KEY", "")
        self.GEMINI_MODEL: str = _env_str("GEMINI_MODEL", "gemini-3.5-flash-lite") or "gemini-3.5-flash-lite"
        self.GEMINI_BASE_URL: str = (
            _env_str("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com")
            or "https://generativelanguage.googleapis.com"
        )
        self.GEMINI_TIMEOUT_SECONDS: float = _env_float("GEMINI_TIMEOUT_SECONDS", 30.0)
        self.GEMINI_TOTAL_TIMEOUT_SECONDS: float = _env_float("GEMINI_TOTAL_TIMEOUT_SECONDS", 45.0)
        self.GEMINI_MAX_RETRIES: int = max(0, _env_int("GEMINI_MAX_RETRIES", 2))

        # -- Copilot ---------------------------------------------------------
        self.COPILOT_MODEL: str = _env_str("COPILOT_MODEL", "")
        self.COPILOT_MAX_TOOL_ROUNDS: int = _env_int("COPILOT_MAX_TOOL_ROUNDS", 6)
        self.COPILOT_LLM_TIMEOUT_SECONDS: float = _env_float("COPILOT_LLM_TIMEOUT_SECONDS", 25.0)
        self.COPILOT_CONFIRM_TTL_SECONDS: float = _env_float("COPILOT_CONFIRM_TTL_SECONDS", 600.0)
        self.COPILOT_MANIFEST_TTL_SECONDS: float = _env_float("COPILOT_MANIFEST_TTL_SECONDS", 300.0)
        self.COPILOT_TOOL_RESULT_MAX_CHARS: int = _env_int("COPILOT_TOOL_RESULT_MAX_CHARS", 8000)
        self.TOOLS_HTTP_TIMEOUT_SECONDS: float = _env_float("TOOLS_HTTP_TIMEOUT_SECONDS", 15.0)

        # -- In-memory agent state -------------------------------------------
        self.AGENT_SESSION_TTL_SECONDS: float = _env_float("AGENT_SESSION_TTL_SECONDS", 7200.0)
        self.AGENT_MAX_SESSIONS: int = max(1, _env_int("AGENT_MAX_SESSIONS", 1000))

        # -- Jobs finder (JOB-FEED.md §12.2) ---------------------------------
        self.JOBS_FINDER_MAX_RESULTS: int = max(1, _env_int("JOBS_FINDER_MAX_RESULTS", 12))
        self.JOBS_FINDER_CAMPUS_LIMIT: int = max(1, _env_int("JOBS_FINDER_CAMPUS_LIMIT", 6))
        self.JOBS_FINDER_TOOL_TIMEOUT_SECONDS: float = _env_float("JOBS_FINDER_TOOL_TIMEOUT_SECONDS", 15.0)
        self.JOBS_SESSION_TTL_SECONDS: float = _env_float("JOBS_SESSION_TTL_SECONDS", 7200.0)
        self.JOBS_SESSION_MAX: int = max(1, _env_int("JOBS_SESSION_MAX", 500))

        # -- Resume agent compaction -----------------------------------------
        # ~4 chars/token -> 6000 chars ~ 1500 tokens.
        self.RESUME_MAX_HISTORY_CHARS: int = _env_int("RESUME_MAX_HISTORY_CHARS", 6000)
        self.RESUME_RECENT_KEEP: int = _env_int("RESUME_RECENT_KEEP", 6)
        self.RESUME_SUMMARY_MAX_TOKENS: int = _env_int("RESUME_SUMMARY_MAX_TOKENS", 300)

        # -- Job creation agent compaction -----------------------------------
        self.JOB_CREATOR_MAX_HISTORY_CHARS: int = _env_int("JOB_CREATOR_MAX_HISTORY_CHARS", 6000)
        self.JOB_CREATOR_RECENT_KEEP: int = _env_int("JOB_CREATOR_RECENT_KEEP", 6)
        self.JOB_CREATOR_SUMMARY_MAX_TOKENS: int = _env_int("JOB_CREATOR_SUMMARY_MAX_TOKENS", 300)

        # -- AI interviewer ----------------------------------------------------
        self.INTERVIEW_MIN_QUESTIONS: int = _env_int("INTERVIEW_MIN_QUESTIONS", 4)
        self.INTERVIEW_MAX_QUESTIONS: int = _env_int("INTERVIEW_MAX_QUESTIONS", 5)
        self.INTERVIEW_MAX_SECONDS: int = _env_int("INTERVIEW_MAX_SECONDS", 600)
        self.INTERVIEW_SESSION_TTL_SECONDS: int = _env_int("INTERVIEW_SESSION_TTL_SECONDS", 7200)
        self.INTERVIEW_MAX_SESSIONS: int = _env_int("INTERVIEW_MAX_SESSIONS", 500)
        self.INTERVIEW_JD_MAX_CHARS: int = _env_int("INTERVIEW_JD_MAX_CHARS", 12000)

    def cors_allowed_origins(self) -> Optional[List[str]]:
        """Origins python-engineio should accept, or None for same-origin only.

        Never ``"*"`` and never ``[]`` (an empty list disables origin checking
        in python-engineio 4.x). Clients that send no ``Origin`` header -- the
        Node backend -- are unaffected either way.
        """
        raw = self.AI_CORS_ORIGINS or ""
        origins: List[str] = []
        for item in raw.split(","):
            origin = item.strip().rstrip("/")
            if not origin:
                continue
            if origin == "*":
                logging.getLogger("config").warning(
                    "AI_CORS_ORIGINS contains '*' -- ignored; list explicit origins instead"
                )
                continue
            if origin not in origins:
                origins.append(origin)
        return origins or None


settings = Settings()
