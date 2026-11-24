import os
from dotenv import load_dotenv

load_dotenv()


class Settings:
    """Runtime config. Everything overridable through environment variables."""

    AI_HOST: str = os.getenv("AI_HOST", "0.0.0.0")
    AI_PORT: int = int(os.getenv("AI_PORT", "9000"))
    STREAM_DELAY: float = float(os.getenv("STREAM_DELAY", "0.08"))
    GEMINI_API_KEY: str = os.getenv("GEMINI_API_KEY", "")
    GEMINI_MODEL: str = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")

    # Token compaction for the Resume Agent
    # Trigger compaction when total history character count exceeds this value.
    # ~4 chars/token → 6000 chars ≈ 1500 tokens (safe for Gemini Flash Lite).
    RESUME_MAX_HISTORY_CHARS: int = int(os.getenv("RESUME_MAX_HISTORY_CHARS", "6000"))
    # Number of most-recent history turns to keep verbatim after compaction.
    RESUME_RECENT_KEEP: int = int(os.getenv("RESUME_RECENT_KEEP", "6"))
    # Max output tokens for the compaction summary call.
    RESUME_SUMMARY_MAX_TOKENS: int = int(os.getenv("RESUME_SUMMARY_MAX_TOKENS", "300"))

    # Token compaction for the Job Creation Agent
    # Trigger compaction when total history character count exceeds this value.
    # ~4 chars/token → 6000 chars ≈ 1500 tokens (safe for Gemini Flash Lite).
    JOB_CREATOR_MAX_HISTORY_CHARS: int = int(os.getenv("JOB_CREATOR_MAX_HISTORY_CHARS", "6000"))
    # Number of most-recent history turns to keep verbatim after compaction.
    JOB_CREATOR_RECENT_KEEP: int = int(os.getenv("JOB_CREATOR_RECENT_KEEP", "6"))
    # Max output tokens for the compaction summary call.
    JOB_CREATOR_SUMMARY_MAX_TOKENS: int = int(os.getenv("JOB_CREATOR_SUMMARY_MAX_TOKENS", "300"))

    # AI Interviewer Agent
    # Aim for four questions when coverage is sufficient and never exceed five.
    INTERVIEW_MIN_QUESTIONS: int = int(os.getenv("INTERVIEW_MIN_QUESTIONS", "4"))
    INTERVIEW_MAX_QUESTIONS: int = int(os.getenv("INTERVIEW_MAX_QUESTIONS", "5"))
    # Hard cap on how long one mock interview may run, in seconds. The clock
    # starts when the first question is asked; every later turn checks it.
    INTERVIEW_MAX_SECONDS: int = int(os.getenv("INTERVIEW_MAX_SECONDS", "600"))
    # Drop an interview session after this much inactivity (seconds).
    INTERVIEW_SESSION_TTL_SECONDS: int = int(os.getenv("INTERVIEW_SESSION_TTL_SECONDS", "7200"))
    # Hard cap on concurrently retained interview sessions.
    INTERVIEW_MAX_SESSIONS: int = int(os.getenv("INTERVIEW_MAX_SESSIONS", "500"))
    # Max characters of job-page text handed to Gemini for JD extraction.
    INTERVIEW_JD_MAX_CHARS: int = int(os.getenv("INTERVIEW_JD_MAX_CHARS", "12000"))


settings = Settings()
