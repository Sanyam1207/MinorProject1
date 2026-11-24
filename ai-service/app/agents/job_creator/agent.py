"""Job Creation Agent.

Registered in ``app/agents/__init__.py`` under the name ``"job-creation"``.

Architecture
------------
Natural language on top   → Gemini extracts intent / job fields
Structured state in middle → JobSessionState / JobData (source of truth)
Deterministic validation below → validator.py decides readiness / validity

Explicit TPO confirmation is required before ``mode:jobCreation:post``
is ever emitted.

Workflow
--------
1. Load (or create) the job-creation session for ``req.sessionId``.
2. Enforce authorization: only ``user_role == "tpo"`` may proceed.
3. Seed institutional context (college_name, available_branches) from meta_data.
4. Compact history if needed (token optimisation).
5. Call Gemini to understand the TPO's message and extract structured updates.
6. Merge the extracted fields into the session deterministically.
7. Validate — determine missing fields and current workflow state.
8. Yield ``JobCreationChunk`` with the appropriate header and payload.
"""

from __future__ import annotations

import copy
import json
import logging
import re
from datetime import datetime, timezone, timedelta
from typing import Any, AsyncIterator, Dict, List, Optional

from app.schemas import QueryRequest
from app.agents.roles import resolve_role
from app.agents.routing import RoutingRules
from app.agents.job_creator.schemas import JobCreationChunk, JobData, JobStatus
from app.agents.job_creator.session import (
    JobSessionState,
    get_or_create_session,
    save_session,
)
from app.agents.job_creator.compactor import build_compact_history, maybe_compact
from app.agents.job_creator.prompt import SYSTEM_PROMPT, build_user_turn
from app.agents.job_creator.validator import (
    FIELD_LABELS,
    get_missing_required_fields,
    is_cancellation_intent,
    is_confirmation_intent,
    is_deadline_expired,
    parse_and_validate_deadline,
    validate_branches,
    friendly_missing,
)

log = logging.getLogger("job_creator.agent")

# IST offset for "now" references
_IST = timezone(timedelta(hours=5, minutes=30))


class JobCreationAgent:
    """Job Creation Agent — collects job posting information conversationally
    and requires explicit TPO confirmation before marking a job as posted.
    """

    name = "job-creation"

    ROUTING_RULES = RoutingRules(
        strong=(
            r"\b(post|create|publish|add|draft|put\s+up)\b[^.?!]{0,20}\b(job|opening|listing|vacancy|drive)\b",
            r"\bjob\s+(posting|creation)\b",
            r"\bnew\s+(job|opening|vacancy)\b",
        ),
        weak=(r"\bpublish\b", r"\blistings?\b", r"\bplacement\s+drive\b"),
        veto=(
            r"\bmock\s+interview\b",
            # The job tracker belongs to the jobs-finder (JOB-FEED.md §12.9):
            # "add the 2nd job to my wishlist" must never reach job creation.
            r"\b(wish\s*-?\s*list|bookmarks?|shortlist(ed)?|favou?rites?|job\s+tracker|saved\s+jobs?)\b",
            r"\bas\s+applied\b",
        ),
    )
    SWITCH_MESSAGE = "Sure -- let's get that job posted."

    # run() yields JobCreationChunk objects, which carry their own wire format.
    emits_own_chunks = True
    content_header = JobCreationChunk.HEADER_DATA

    @staticmethod
    def error_chunk(message: str, session_id: str = "") -> JobCreationChunk:
        return JobCreationChunk.error_chunk(response=message, session_id=session_id)

    async def run(self, req: QueryRequest) -> AsyncIterator[Any]:
        sid = req.sessionId

        # ── 1. Authorization — deterministic, before any LLM call ────────────
        # Defence in depth: the router never sends students here.
        if resolve_role(req) not in ("tpo", "admin"):
            yield JobCreationChunk.error_chunk(
                response=(
                    "You are not eligible to create or post a job. "
                    "Only TPO users can perform this action."
                ),
                session_id=sid,
            )
            return

        # ── 2. Load session ───────────────────────────────────────────────────
        session = get_or_create_session(sid)

        # ── 3. Seed institutional context from meta_data (once per session) ──
        meta_data: Dict[str, Any] = req.meta_data or {}
        if meta_data.get("college_name") and not session.college_name:
            session.college_name = meta_data["college_name"]
        if meta_data.get("branches") and not session.available_branches:
            session.available_branches = list(meta_data["branches"])

        # Fallback if meta_data is absent
        available_branches = session.available_branches or []
        college_name = session.college_name or "Unknown College"

        current_dt_iso = datetime.now(_IST).isoformat()

        try:
            async for chunk in self._handle(
                req=req,
                session=session,
                sid=sid,
                user_message=req.user_query,
                available_branches=available_branches,
                college_name=college_name,
                current_dt_iso=current_dt_iso,
                meta_data=meta_data,
            ):
                yield chunk
        except Exception:
            log.exception("[%s] job-creation agent error", req.requestId)
            yield JobCreationChunk.error_chunk(
                response="Something went wrong while processing your request. Please try again.",
                draft_id=session.draft_id,
                session_id=sid,
            )
        finally:
            save_session(sid, session)

    # -------------------------------------------------------------------------
    # Main handler (async generator)
    # -------------------------------------------------------------------------

    async def _handle(
        self,
        req: QueryRequest,
        session: JobSessionState,
        sid: str,
        user_message: str,
        available_branches: List[str],
        college_name: str,
        current_dt_iso: str,
        meta_data: Dict[str, Any],
    ) -> AsyncIterator[Any]:

        # ── Fast-path: deterministic confirmation / cancellation detection ────
        # Only when session is currently awaiting a yes/no from the TPO. This
        # is the ONLY way a job gets posted -- the LLM can never confirm.
        was_awaiting = session.awaiting_confirmation
        if session.awaiting_confirmation:
            if is_confirmation_intent(user_message):
                async for chunk in self._do_post(session, sid):
                    yield chunk
                return
            if is_cancellation_intent(user_message):
                async for chunk in self._do_cancel(session, sid):
                    yield chunk
                return
            # Falls through — TPO sent something else while awaiting;
            # treat it as a new edit and reset awaiting_confirmation.
            session.awaiting_confirmation = False

        # ── Token compaction — before LLM call ───────────────────────────────
        await maybe_compact(session)
        compact_history = build_compact_history(session)

        # ── Build user turn with full context ─────────────────────────────────
        user_turn = build_user_turn(
            job_state=session.job.to_dict(),
            meta_data={"college_name": college_name},
            user_message=user_message,
            available_branches=available_branches,
            missing_fields=session.missing_fields,
            awaiting_confirmation=session.awaiting_confirmation,
            current_datetime_iso=current_dt_iso,
        )

        # ── Call Gemini (non-streaming — structured extraction) ───────────────
        llm_reply = await self._call_gemini(compact_history, user_turn)

        # ── Parse the JSON block from LLM reply ──────────────────────────────
        extracted = _extract_json_block(llm_reply) or {}
        clean_reply = _strip_json_block(llm_reply).strip()

        # Update history
        session.append_history("user", user_turn)
        session.append_history("model", llm_reply)

        # ── Deterministic action dispatch from extracted["action"] ────────────
        # An LLM "confirm" is never honoured (only the deterministic classifier
        # above can post); an LLM "cancel" only while a yes/no was pending.
        action = str(extracted.get("action") or "collect").lower()
        if action == "cancel" and was_awaiting:
            async for chunk in self._do_cancel(session, sid):
                yield chunk
            return

        # ── Merge extracted fields into session ───────────────────────────────
        warnings: List[str] = []
        _merge_extracted(
            session=session,
            extracted=extracted,
            available_branches=available_branches,
            current_dt_iso=current_dt_iso,
            warnings=warnings,
        )

        # ── Recompute missing fields and state ────────────────────────────────
        session.missing_fields = get_missing_required_fields(session.job)
        is_complete = len(session.missing_fields) == 0

        if is_complete:
            session.status = JobStatus.READY
        else:
            session.status = JobStatus.DATA
            # If we were somehow awaiting confirmation but a field was removed,
            # cancel the confirmation flow
            session.awaiting_confirmation = False

        # ── Check for "post the job" request (only valid when READY) ─────────
        # We detect this via the LLM action="edit" + user message contains "post"
        # OR we check the user message directly for post intent keywords.
        if session.status == JobStatus.READY and _user_wants_to_post(user_message):
            async for chunk in self._request_confirmation(session, sid, clean_reply):
                yield chunk
            return

        # ── Compose final human-readable response ─────────────────────────────
        response_text = _compose_response(
            clean_reply=clean_reply,
            status=session.status,
            missing_fields=session.missing_fields,
            warnings=warnings,
        )

        # ── Yield the appropriate chunk ───────────────────────────────────────
        if session.status == JobStatus.READY:
            yield JobCreationChunk.ready_chunk(
                response=response_text,
                job=session.job,
                draft_id=session.draft_id,
                session_id=sid,
                is_end=True,
            )
        else:
            yield JobCreationChunk.data_chunk(
                response=response_text,
                job=session.job,
                missing_fields=session.missing_fields,
                draft_id=session.draft_id,
                session_id=sid,
                is_end=True,
            )

    # -------------------------------------------------------------------------
    # Request confirmation — transitions to awaiting_confirmation
    # -------------------------------------------------------------------------

    async def _request_confirmation(
        self, session: JobSessionState, sid: str, clean_reply: str
    ) -> AsyncIterator[Any]:
        """Request confirmation before posting."""
        session.awaiting_confirmation = True
        yield JobCreationChunk.confirmation_chunk(
            response=(
                clean_reply
                or "The job is ready to be posted. Do you want to post it?"
            ),
            job=session.job,
            draft_id=session.draft_id,
            session_id=sid,
            is_end=True,
        )

    # -------------------------------------------------------------------------
    # Post confirmation
    # -------------------------------------------------------------------------

    async def _do_post(
        self, session: JobSessionState, sid: str
    ) -> AsyncIterator[Any]:
        """Yield a POST chunk after explicit confirmation."""
        # Final safety checks (deterministic)
        missing = get_missing_required_fields(session.job)
        if missing:
            # Mandatory field disappeared between confirmation request and confirm
            session.awaiting_confirmation = False
            session.status = JobStatus.DATA
            session.missing_fields = missing
            yield JobCreationChunk.data_chunk(
                response=(
                    "Some required information is now missing before the job can be posted. "
                    f"Please provide: {friendly_missing(missing)}."
                ),
                job=session.job,
                missing_fields=missing,
                draft_id=session.draft_id,
                session_id=sid,
                is_end=True,
            )
            return

        # Snapshot, then start a fresh draft BEFORE yielding, so a later
        # "post it" can never post (and Node can never persist) this job twice.
        posted = copy.deepcopy(session.job)
        posted_draft = session.draft_id
        session.reset_after_post()

        log.info("job-creation draft %s confirmed for posting", posted_draft)

        yield JobCreationChunk.post_chunk(
            response=(
                f"The **{posted.job_role}** position at **{posted.company_name}** "
                f"has been posted successfully! Students can now apply before "
                f"{posted.app_deadline}."
            ),
            job=posted,
            draft_id=posted_draft,
            session_id=sid,
            is_end=True,
        )

    # -------------------------------------------------------------------------
    # Post cancellation
    # -------------------------------------------------------------------------

    async def _do_cancel(
        self, session: JobSessionState, sid: str
    ) -> AsyncIterator[Any]:
        """Cancel posting; remain in READY state."""
        session.awaiting_confirmation = False
        yield JobCreationChunk.ready_chunk(
            response=(
                "Okay, the job has not been posted. "
                "You can make changes or post it whenever you're ready."
            ),
            job=session.job,
            draft_id=session.draft_id,
            session_id=sid,
            is_end=True,
        )

    # -------------------------------------------------------------------------
    # Gemini call
    # -------------------------------------------------------------------------

    async def _call_gemini(
        self,
        history: List[Dict[str, Any]],
        user_turn: str,
    ) -> str:
        """Non-streaming Gemini call for field extraction."""
        from app.agents.job_creator.llm import call_gemini_chat  # noqa: PLC0415
        return await call_gemini_chat(
            system_prompt=SYSTEM_PROMPT,
            history=history,
            user_turn=user_turn,
        )


# ---------------------------------------------------------------------------
# Post-request intent detection (deterministic)
# ---------------------------------------------------------------------------

POST_REQUEST_RE = re.compile(
    r"\b(post|publish|submit)\s+(it|this|the\s+job|this\s+job|the\s+listing|now)\b|\b(go|make\s+it)\s+live\b",
    re.IGNORECASE,
)
NEGATION_RE = re.compile(r"\b(don'?t|do\s+not|not\s+yet|never|without)\b", re.IGNORECASE)


def _user_wants_to_post(text: str) -> bool:
    """True when the message asks to post the job (and does not negate it)."""
    t = (text or "").replace("\u2019", "'")
    return bool(POST_REQUEST_RE.search(t)) and not NEGATION_RE.search(t)


# ---------------------------------------------------------------------------
# Deterministic field merging (no LLM calls)
# ---------------------------------------------------------------------------


def _merge_extracted(
    session: JobSessionState,
    extracted: Dict[str, Any],
    available_branches: List[str],
    current_dt_iso: str,
    warnings: List[str],
) -> None:
    """Apply LLM-extracted fields to the session's JobData in-place.

    Rules:
    - null → field was not mentioned this turn; leave existing value.
    - "" (empty string) → explicit removal; clear the field.
    - Non-null non-empty → update the field.
    - Always run deterministic validation after applying.
    """
    job = session.job
    remove_fields: List[str] = extracted.get("remove_fields") or []

    # ── String fields ─────────────────────────────────────────────────────
    for attr, key in [
        ("company_name", "company_name"),
        ("job_role", "job_role"),
        ("job_description", "job_description"),
        ("location", "location"),
        ("employment_type", "employment_type"),
        ("minimum_cgpa", "minimum_cgpa"),
        ("maximum_backlogs", "maximum_backlogs"),
        ("selection_process", "selection_process"),
    ]:
        raw_val = extracted.get(key)
        if key in remove_fields or raw_val == "":
            setattr(job, attr, "")
        elif raw_val is not None:
            setattr(job, attr, str(raw_val).strip())

    # ── Salary — special: default is "not disclosed", not "" ─────────────
    raw_salary = extracted.get("salary")
    if "salary" in remove_fields or raw_salary == "":
        job.salary = "not disclosed"
    elif raw_salary is not None:
        job.salary = str(raw_salary).strip() or "not disclosed"

    # ── Application deadline — parse + validate ───────────────────────────
    raw_deadline = extracted.get("app_deadline_raw")
    if "app_deadline" in remove_fields or raw_deadline == "":
        job.app_deadline = ""
    elif raw_deadline is not None:
        iso_dt, err = parse_and_validate_deadline(raw_deadline, current_dt_iso)
        if err:
            warnings.append(f"Deadline issue: {err}")
        elif is_deadline_expired(iso_dt, current_dt_iso):
            warnings.append(
                f"The deadline '{raw_deadline}' appears to already be in the past. "
                "Please provide a future deadline."
            )
        else:
            job.app_deadline = iso_dt

    # ── Eligible branches — validate against available ────────────────────
    raw_branches = extracted.get("eligible_branches")
    if "eligible_branches" in remove_fields:
        # Explicit removal → back to all branches
        job.eligible_branches = list(available_branches)
    elif raw_branches is not None and isinstance(raw_branches, list):
        if len(raw_branches) == 0:
            # Empty list means "all branches"
            job.eligible_branches = list(available_branches)
        else:
            valid, invalid = validate_branches(raw_branches, available_branches)
            if invalid:
                avail_str = ", ".join(available_branches)
                warnings.append(
                    f"The following branches are not available for this college and were ignored: "
                    f"{', '.join(invalid)}. "
                    f"Available branches: {avail_str}."
                )
            if valid:
                job.eligible_branches = valid
            # If all were invalid, keep the existing eligible_branches

    # ── List fields ───────────────────────────────────────────────────────
    raw_skills = extracted.get("skills")
    if "skills" in remove_fields or raw_skills == []:
        job.skills = []
    elif raw_skills is not None and isinstance(raw_skills, list):
        job.skills = [str(s).strip() for s in raw_skills if s]

    raw_grad_years = extracted.get("graduation_years")
    if "graduation_years" in remove_fields or raw_grad_years == []:
        job.graduation_years = []
    elif raw_grad_years is not None and isinstance(raw_grad_years, list):
        job.graduation_years = [str(y).strip() for y in raw_grad_years if y]

    # ── Apply defaults for fields that were never set ─────────────────────
    if not job.salary:
        job.salary = "not disclosed"
    if not job.eligible_branches and available_branches:
        job.eligible_branches = list(available_branches)


# ---------------------------------------------------------------------------
# Response composition
# ---------------------------------------------------------------------------


def _compose_response(
    clean_reply: str,
    status: JobStatus,
    missing_fields: List[str],
    warnings: List[str],
) -> str:
    """Build the final response text to emit to the TPO."""
    parts: List[str] = []

    if clean_reply:
        parts.append(clean_reply)

    if warnings:
        parts.append("\n⚠️ " + "\n⚠️ ".join(warnings))

    if not clean_reply:
        # LLM produced no prose — fall back to sensible defaults
        if status == JobStatus.READY:
            parts.append("✅ All required information is complete. The job is ready to post!")
        elif missing_fields:
            parts.append(
                f"To complete the job posting, please provide the following: "
                f"**{friendly_missing(missing_fields)}**."
            )

    return "\n".join(parts).strip()


# ---------------------------------------------------------------------------
# JSON extraction helpers
# ---------------------------------------------------------------------------


def _extract_json_block(text: str) -> Optional[Dict[str, Any]]:
    """Extract and parse the first ```json ... ``` block from *text*."""
    match = re.search(r"```json\s*(.*?)\s*```", text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1))
        except json.JSONDecodeError:
            pass
    # Fallback: try to parse a bare JSON object
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(0))
        except json.JSONDecodeError:
            pass
    return None


def _strip_json_block(text: str) -> str:
    """Remove the ```json ... ``` block from *text*, leaving only prose."""
    cleaned = re.sub(r"```json\s*.*?\s*```", "", text, flags=re.DOTALL)
    return cleaned.strip()
