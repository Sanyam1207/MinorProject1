"""Token compaction for the Job Creation Agent.

When ``session.history`` grows beyond ``settings.JOB_CREATOR_MAX_HISTORY_CHARS``
characters, this module:

1. Splits history into *old* turns (to be summarised) and *recent* turns
   (kept verbatim).
2. Calls Gemini non-streaming to produce a concise summary of the old turns.
3. Replaces the old turns with the summary stored in
   ``session.conversation_summary``.  The ``session.history`` list is
   trimmed to only the recent turns.

On failure the session is left completely untouched — compaction is an
optimisation, not a hard dependency.

``build_compact_history`` then constructs the actual list passed to the LLM:

    [synthetic summary turn]   ← older context (compacted)
    +
    session.history             ← recent verbatim turns

The structured ``session.job`` (JobData) is always kept separately and is
NEVER replaced by a summary — it is the canonical source of truth.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

from app.config import settings

log = logging.getLogger("job_creator.compactor")

# ---------------------------------------------------------------------------
# System prompt used only for the compaction summarisation call
# ---------------------------------------------------------------------------

_COMPACT_SYSTEM_PROMPT = """\
You are a context-compaction assistant for a job-creation AI assistant.

You will receive a list of previous conversation turns between a TPO
(Training and Placement Officer) and the job-creation assistant, along with
the current structured job state.

Your task:
Write a concise factual summary (3-6 sentences) of the conversation that
preserves all information needed for future reasoning:
  - What job the TPO wants to create (company, role, description highlights)
  - Important decisions the TPO made (branch restrictions, salary choices,
    eligibility constraints, field removals/updates)
  - Whether the TPO was waiting for confirmation to post
  - Any important corrections or constraints the TPO stated
  - Workflow phase (collecting info / ready to post / confirmed)

Do NOT include:
  - Greetings / filler conversation
  - Facts already fully captured in the structured job state JSON
  - Invented or assumed facts
  - Any raw JSON blobs

Output only the summary paragraph. No headings, no bullet points.
""".strip()


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def estimate_history_chars(history: List[Dict[str, Any]]) -> int:
    """Count total characters across all history turns (fast proxy for tokens)."""
    total = 0
    for turn in history:
        for part in turn.get("parts", []):
            total += len(part.get("text", ""))
    return total


async def maybe_compact(session) -> None:
    """Compact ``session.history`` in-place if it exceeds the configured
    character threshold.  Safe-fails on any error.

    Parameters
    ----------
    session:  A ``JobSessionState`` instance (typed loosely to avoid a
              circular import).
    """
    size = estimate_history_chars(session.history)
    if size < settings.JOB_CREATOR_MAX_HISTORY_CHARS:
        return  # Nothing to do

    keep = settings.JOB_CREATOR_RECENT_KEEP
    # Need at least (keep+2) turns before compacting is worthwhile
    if len(session.history) <= keep + 2:
        return

    old_turns = session.history[:-keep]
    recent_turns = session.history[-keep:]

    log.info(
        "compacting job-creation history for session — %d chars, %d turns → keeping last %d",
        size,
        len(session.history),
        keep,
    )

    # Build a JSON snapshot of the current job state for context
    job_snapshot = _job_snapshot(session)

    try:
        summary = await _generate_summary(old_turns, job_snapshot)
    except Exception:
        log.exception("job-creation compaction summarisation failed — keeping full history")
        return  # Safe-fail: leave session untouched

    if not summary:
        log.warning("job-creation compaction produced an empty summary — skipping")
        return

    session.conversation_summary = summary
    session.compacted_turns_count += len(old_turns)
    session.history = recent_turns

    log.info(
        "job-creation compaction done: %d old turns summarised, %d recent turns kept",
        len(old_turns),
        len(recent_turns),
    )


def build_compact_history(session) -> List[Dict[str, Any]]:
    """Return the history list to pass to the LLM.

    If a summary exists, it is prepended as a synthetic model turn so the
    LLM sees: [older context summary] + [recent verbatim turns].

    If no compaction has occurred, returns ``session.history`` unchanged.
    """
    if not session.conversation_summary:
        return list(session.history)

    summary_turn = {
        "role": "model",
        "parts": [
            {
                "text": (
                    f"[Context summary of earlier job-creation conversation]\n"
                    f"{session.conversation_summary}"
                )
            }
        ],
    }
    return [summary_turn] + list(session.history)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _job_snapshot(session) -> str:
    """Minimal JSON snapshot of the current job state."""
    try:
        snap = {
            "job": session.job.to_dict(),
            "status": session.status.value,
            "missing_fields": session.missing_fields,
            "awaiting_confirmation": session.awaiting_confirmation,
            "college_name": session.college_name,
            "available_branches": session.available_branches,
        }
        return json.dumps(snap, ensure_ascii=False)
    except Exception:
        return "{}"


async def _generate_summary(
    old_turns: List[Dict[str, Any]],
    job_snapshot: str,
) -> Optional[str]:
    """Call Gemini non-streaming to summarise *old_turns*.

    Reuses ``call_gemini_chat`` from the resume_generator latex module
    to avoid duplicating HTTP logic.
    """
    # Import here to avoid circular imports at module load time
    from app.agents.job_creator.llm import call_gemini_chat  # noqa: PLC0415

    import re

    # Reconstruct a readable transcript from the old turns, stripping
    # embedded JSON blobs (already in job_snapshot).
    transcript_lines: List[str] = []
    for turn in old_turns:
        role = turn.get("role", "unknown")
        text = ""
        for part in turn.get("parts", []):
            text += part.get("text", "")
        # Strip embedded ```json ... ``` blocks — that info is in job_snapshot
        text = re.sub(r"```json.*?```", "", text, flags=re.DOTALL)
        # Also strip the CURRENT JOB STATE block injected by build_user_turn
        text = re.sub(r"CURRENT JOB STATE:.*?```", "", text, flags=re.DOTALL)
        text = text.strip()
        if text:
            transcript_lines.append(f"{role.upper()}: {text}")

    transcript = "\n".join(transcript_lines)
    user_turn = (
        f"Conversation to summarise:\n{transcript}\n\n"
        f"Current job state (structured, do not re-summarise this):\n"
        f"```json\n{job_snapshot}\n```\n\n"
        f"Write a concise summary of the conversation above."
    )

    return await call_gemini_chat(
        system_prompt=_COMPACT_SYSTEM_PROMPT,
        history=[],
        user_turn=user_turn,
    )
