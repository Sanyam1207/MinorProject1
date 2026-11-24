"""Token compaction for the Resume Generator Agent.

When ``session.history`` grows beyond ``settings.RESUME_MAX_HISTORY_CHARS``
characters, this module:

1. Splits history into *old* turns (to be summarised) and *recent* turns
   (kept verbatim).
2. Calls Gemini non-streaming (reusing ``call_gemini_chat``) to produce a
   concise summary of the old turns.
3. Replaces the old turns with the summary stored in
   ``session.conversation_summary``.  The ``session.history`` list is
   trimmed to only the recent turns.

On failure the session is left completely untouched — compaction is an
optimisation, not a hard dependency.

``build_compact_history`` then constructs the actual list passed to the LLM:

    [synthetic summary turn]   ← older context (compacted)
    +
    session.history             ← recent verbatim turns
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

from app.config import settings

log = logging.getLogger("resume_agent.compactor")

# ---------------------------------------------------------------------------
# System prompt used only for the compaction summarisation call
# ---------------------------------------------------------------------------

_COMPACT_SYSTEM_PROMPT = """\
You are a context-compaction assistant for a resume-building AI.

You will receive a list of previous conversation turns between a user and
a resume assistant, along with the current structured resume state.

Your task:
Write a concise factual summary (3-6 sentences) of the conversation that
preserves all information needed for future reasoning:
  - User intent and current workflow phase
  - Important decisions the user made (e.g. sections skipped, edits requested)
  - Resume-related facts explicitly provided by the user that are NOT yet
    reflected in the structured resume state
  - User preferences (e.g. preferred tone, short descriptions, etc.)
  - Important corrections or constraints

Do NOT include:
  - Filler conversation / greetings
  - Facts already captured in the structured resume state JSON
  - Any generated LaTeX code
  - Invented or assumed facts

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
    session:  A ``ResumeSessionState`` instance (typed loosely to avoid a
              circular import).
    """
    size = estimate_history_chars(session.history)
    if size < settings.RESUME_MAX_HISTORY_CHARS:
        return  # Nothing to do

    keep = settings.RESUME_RECENT_KEEP
    # Need at least (keep+2) turns before compacting is worthwhile
    if len(session.history) <= keep + 2:
        return

    old_turns = session.history[:-keep]
    recent_turns = session.history[-keep:]

    log.info(
        "compacting history for session — %d chars, %d turns → keeping last %d",
        size,
        len(session.history),
        keep,
    )

    # Build the resume state dict for context (without LaTeX — it's an artifact)
    resume_snapshot = _resume_snapshot(session)

    try:
        summary = await _generate_summary(old_turns, resume_snapshot)
    except Exception:
        log.exception("compaction summarisation failed — keeping full history")
        return  # Safe-fail: leave session untouched

    if not summary:
        log.warning("compaction produced an empty summary — skipping")
        return

    session.conversation_summary = summary
    session.compacted_turns_count += len(old_turns)
    session.history = recent_turns

    log.info(
        "compaction done: %d old turns summarised, %d recent turns kept",
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
                    f"[Context summary of earlier conversation]\n"
                    f"{session.conversation_summary}"
                )
            }
        ],
    }
    return [summary_turn] + list(session.history)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _resume_snapshot(session) -> str:
    """Minimal JSON snapshot of the resume state (no LaTeX)."""
    r = session.resume
    try:
        snapshot = {
            "personal": r.personal.model_dump(),
            "education": [e.model_dump() for e in r.education],
            "experience": [e.model_dump() for e in r.experience],
            "projects": [p.model_dump() for p in r.projects],
            "skills": r.skills,
            "section_flags": {k: v.value for k, v in session.section_flags.items()},
        }
        return json.dumps(snapshot, ensure_ascii=False)
    except Exception:
        return "{}"


async def _generate_summary(
    old_turns: List[Dict[str, Any]],
    resume_snapshot: str,
) -> Optional[str]:
    """Call Gemini non-streaming to summarise ``old_turns``.

    Reuses ``call_gemini_chat`` from latex.py to avoid duplicating HTTP logic.
    """
    # Import here to avoid circular imports at module load time
    from app.agents.resume_generator.latex import call_gemini_chat  # noqa: PLC0415

    # Reconstruct a readable transcript from the old turns, stripping the
    # embedded resume JSON blobs to keep the prompt tight.
    transcript_lines: List[str] = []
    for turn in old_turns:
        role = turn.get("role", "unknown")
        text = ""
        for part in turn.get("parts", []):
            text += part.get("text", "")
        # Strip the embedded ```json ... ``` blocks from user turns —
        # that information is already in resume_snapshot.
        import re
        text = re.sub(r"Current resume state:\s*```json.*?```\s*", "", text, flags=re.DOTALL)
        text = text.strip()
        if text:
            transcript_lines.append(f"{role.upper()}: {text}")

    transcript = "\n".join(transcript_lines)
    user_turn = (
        f"Conversation to summarise:\n{transcript}\n\n"
        f"Current resume state (structured, do not re-summarise this):\n"
        f"```json\n{resume_snapshot}\n```\n\n"
        f"Write a concise summary of the conversation above."
    )

    # We pass an empty history — this is a one-shot summarisation call
    return await call_gemini_chat(
        system_prompt=_COMPACT_SYSTEM_PROMPT,
        history=[],
        user_turn=user_turn,
    )
