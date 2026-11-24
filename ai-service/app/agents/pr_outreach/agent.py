"""PR Outreach Agent.

Registered in ``app/agents/__init__.py`` under the name ``"pr-outreach"``.

Architecture
------------
Conversational flow on top  → Gemini drives the question sequence
Structured extraction below → deterministic JSON + confidence parsing

Workflow
--------
1. Receive user message and metadata (user_context with skills, cgpa, etc.).
2. Feed the conversation history + user context to Gemini.
3. Gemini either asks a follow-up question OR drafts the email.
4. When a JSON email block is detected → emit ``pr_outreach_satisfied`` with
   confidence, followed by ``mail:review`` carrying the editable draft.
5. Otherwise yield ``PROutreachChunk.question_chunk`` to continue the conversation.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, AsyncIterator, Dict, List, Optional

from app.schemas import QueryRequest
from app.agents.pr_outreach.schemas import PROutreachChunk, EmailDraft
from app.agents.pr_outreach.prompt import SYSTEM_PROMPT, build_user_turn
from app.agents.pr_outreach.llm import call_gemini_chat
from app.agents.routing import RoutingRules

log = logging.getLogger("pr_outreach.agent")

# ---------------------------------------------------------------------------
# In-memory session store (same pattern as job_creator/session.py)
# ---------------------------------------------------------------------------

_sessions: Dict[str, "_OutreachSession"] = {}


class _OutreachSession:
    """Lightweight in-memory conversation state for one outreach session."""

    __slots__ = ("history", "user_context", "current_draft", "confidence_score")

    def __init__(self) -> None:
        self.history: List[Dict[str, Any]] = []
        self.user_context: Optional[Dict[str, Any]] = None
        self.current_draft: Optional[Dict[str, Any]] = None
        self.confidence_score: Optional[float] = None

    def append(self, role: str, text: str) -> None:
        self.history.append({"role": role, "parts": [{"text": text}]})


def _get_session(session_id: str) -> _OutreachSession:
    if session_id not in _sessions:
        _sessions[session_id] = _OutreachSession()
    return _sessions[session_id]


# ---------------------------------------------------------------------------
# Agent
# ---------------------------------------------------------------------------


class PROutreachAgent:
    """PR & Outreach Agent — drafts professional emails conversationally."""

    name = "pr-outreach"

    ROUTING_RULES = RoutingRules(
        strong=(
            r"\b(draft|write|create|compose|send)\b[^.?!]{0,35}\b(email|mail|outreach)\b",
            r"\b(cold|outreach)\s+(email|mail)\b",
            r"\b(reach\s+out|contact|invite)\b[^.?!]{0,45}\b(hr|recruiter|company|campus|employer)\b",
        ),
        weak=(r"\boutreach\b", r"\bemail\b", r"\bmail\b"),
        veto=(r"\b(share|send)\b[^.?!]{0,30}\b(resume|cv)\b",),
    )
    SWITCH_MESSAGE = "Sure -- let's draft your outreach email."
    emits_own_chunks = True
    content_header = PROutreachChunk.HEADER_IN_PROGRESS

    @staticmethod
    def error_chunk(message: str, session_id: str = "") -> PROutreachChunk:
        return PROutreachChunk.error_chunk(response=message)

    async def run(self, req: QueryRequest) -> AsyncIterator[Any]:
        session = _get_session(req.sessionId)

        if _is_mail_sent_confirmation(req.user_query):
            _sessions.pop(req.sessionId, None)
            yield PROutreachChunk.completion_chunk()
            return

        # Seed user_context from meta_data on the first turn.
        meta: Dict[str, Any] = req.meta_data or {}
        if meta.get("user_context") and session.user_context is None:
            session.user_context = meta["user_context"]

        # The RHS composer is editable. Its optional snapshot is the latest
        # source of truth and is kept with this session for later chat turns.
        if req.mail_draft is not None:
            incoming_draft = req.mail_draft.model_dump(exclude_none=True)
            if session.current_draft is not None or any(
                incoming_draft.get(field) for field in ("to", "subject", "body")
            ):
                session.current_draft = incoming_draft

        user_turn = build_user_turn(
            user_message=req.user_query,
            user_context=session.user_context,
            current_mail_draft=session.current_draft,
        )

        try:
            llm_reply = await call_gemini_chat(
                system_prompt=SYSTEM_PROMPT,
                history=session.history,
                user_turn=user_turn,
            )
        except Exception as exc:
            log.exception("[%s] pr-outreach LLM call failed", req.requestId)
            yield PROutreachChunk.error_chunk(
                response=f"Something went wrong: {exc}",
            )
            return

        # Persist conversation history.
        session.append("user", user_turn)
        session.append("model", llm_reply)

        # --- Try to extract a JSON email draft from the reply ----------------
        email_dict = _extract_email_json(llm_reply)
        confidence = _extract_confidence(llm_reply)

        if email_dict and email_dict.get("to") and email_dict.get("body"):
            email = EmailDraft(
                subject=email_dict.get("subject", ""),
                to=email_dict["to"],
                body=email_dict["body"],
            )
            # Strip the JSON block from the visible response text.
            visible_reply = _strip_json_and_confidence(llm_reply).strip()
            if not visible_reply:
                visible_reply = "Here's the drafted email for your review:"

            normalized_confidence = confidence / 100.0 if confidence is not None else 0.85
            session.current_draft = email.to_dict()
            session.confidence_score = normalized_confidence

            # Satisfaction describes the agent's confidence in the gathered
            # context. The following chunk is the actual mail review payload.
            yield PROutreachChunk.satisfied_chunk(
                confidence_score=normalized_confidence,
                is_end=False,
            )
            yield PROutreachChunk.draft_chunk(
                response=visible_reply,
                email=email,
                confidence_score=normalized_confidence,
                is_end=True,
            )
        else:
            # Agent is still asking questions — yield a question chunk.
            visible_reply = _strip_json_and_confidence(llm_reply).strip() or llm_reply
            yield PROutreachChunk.question_chunk(
                response=visible_reply,
                is_end=True,
            )


# ---------------------------------------------------------------------------
# Extraction helpers
# ---------------------------------------------------------------------------

_EMAIL_JSON_RE = re.compile(r"```json\s*(.*?)\s*```", re.DOTALL)
_CONFIDENCE_RE = re.compile(r"CONFIDENCE:\s*(\d+(?:\.\d+)?)", re.IGNORECASE)
_MAIL_SENT_RE = re.compile(
    r"\b(?:i\s+have|i've)\s+sent\s+the\s+(?:mail|email)\b.*\baccepted\b.*\b(?:format|draft)\b",
    re.IGNORECASE | re.DOTALL,
)


def _is_mail_sent_confirmation(text: str) -> bool:
    """Recognize the UI's post-send message without making another LLM call."""
    return bool(_MAIL_SENT_RE.search(text or ""))


def _extract_email_json(text: str) -> Optional[Dict[str, Any]]:
    """Extract the ``{subject, to, body}`` JSON block from the LLM reply."""
    match = _EMAIL_JSON_RE.search(text)
    if match:
        try:
            return json.loads(match.group(1))
        except json.JSONDecodeError:
            pass
    # Fallback: bare JSON object
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if match:
        try:
            obj = json.loads(match.group(0))
            if "to" in obj or "body" in obj or "subject" in obj:
                return obj
        except json.JSONDecodeError:
            pass
    return None


def _extract_confidence(text: str) -> Optional[float]:
    """Extract the ``CONFIDENCE: <number>`` value (0-100 scale)."""
    match = _CONFIDENCE_RE.search(text)
    if match:
        try:
            return float(match.group(1))
        except ValueError:
            pass
    return None


def _strip_json_and_confidence(text: str) -> str:
    """Remove the JSON code block and CONFIDENCE line from visible text."""
    cleaned = _EMAIL_JSON_RE.sub("", text)
    cleaned = _CONFIDENCE_RE.sub("", cleaned)
    return cleaned.strip()
