"""Core Resume Generator Agent logic.

This module contains ``ResumeGeneratorAgent``, which is the class registered
in ``app/agents/__init__.py`` under the name ``"resume-generator"``.

The agent is an async generator: every ``yield`` produces a ``ResumeChunk``
that the orchestrator detects and emits directly to the Socket.IO client,
bypassing all job-scraping logic.

Workflow
--------
1.  Load (or create) the session for ``req.sessionId``.
2.  If the session is in ``COLLECTING`` status:
      - Seed the resume with any inline profile data.
      - Call Gemini conversationally to collect missing information.
      - Parse Gemini's reply to extract structured updates from natural language.
      - If Gemini signals ``READY_TO_GENERATE``, switch to generation.
3.  If the session is in ``GENERATING`` / ``EDITING`` status:
      - Build the LaTeX prompt from the current resume state.
      - Stream LaTeX chunks from Gemini SSE.
      - Mark the last chunk with ``is_end=True``.
      - Save the complete LaTeX back to the session.
      - Transition session status to ``EDITING``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any, AsyncIterator

from app.schemas import QueryRequest
from app.agents.routing import RoutingRules

from app.agents.resume_generator.compactor import build_compact_history, maybe_compact
from app.agents.resume_generator.analysis import analyze_resume
from app.agents.resume_generator.latex import stream_and_extract_json, stream_gemini_text
from app.agents.resume_generator.profile import normalize_profile_url, seed_resume_from_profile
from app.agents.resume_generator.prompt import (
    SYSTEM_PROMPT_COLLECT,
    SYSTEM_PROMPT_EDIT,
    SYSTEM_PROMPT_GENERATE,
    build_collect_user_turn,
    build_edit_user_turn,
    build_generate_user_turn,
)
from app.agents.resume_generator.schemas import (
    RESUME_HEADER_MESSAGE,
    ResumeChunk,
    SectionStatus,
    SessionStatus,
)
from app.agents.resume_generator.session import (
    get_or_create_session,
    save_session,
)
from app.agents.resume_generator.tailoring import (
    build_tailoring_context,
    normalize_target_job,
)
from app.agents.jobscrapper.session_store import session_job_store

log = logging.getLogger("resume_agent")

# Keywords that indicate the user wants to skip an optional section
_SKIP_PHRASES = [
    "no", "nope", "skip", "don't want", "dont want", "not interested",
    "leave out", "exclude", "remove", "without", "none", "no thanks",
    "not needed", "don't include", "dont include", "n/a",
]

# Keywords that indicate the user wants to trigger generation
_GENERATE_TRIGGERS = [
    "generate", "generate it", "generate now", "yes, generate",
    "yes generate", "create it", "create resume", "make it",
    "that's all", "thats all", "done", "finish", "finalize",
    "proceed", "go ahead", "ready", "yes",
]


def _user_wants_to_skip(text: str) -> bool:
    t = text.strip().lower()
    return any(phrase in t for phrase in _SKIP_PHRASES) and len(t) < 60


def _user_wants_to_generate(text: str) -> bool:
    t = text.strip().lower()
    return any(trigger in t for trigger in _GENERATE_TRIGGERS)


def _user_requests_job_tailoring(text: str) -> bool:
    normalized = (text or "").strip().lower()
    has_resume = any(word in normalized for word in ("resume", "cv"))
    return has_resume and any(phrase in normalized for phrase in (
        "tailor", "job specific", "job-specific", "for this job",
        "for the selected job", "for this role", "for the selected role",
    ))


def _selected_job(req: QueryRequest) -> dict | None:
    meta = req.meta_data if isinstance(req.meta_data, dict) else {}
    selected = normalize_target_job(meta.get("selected_job"))
    if selected:
        return selected
    return normalize_target_job(session_job_store.get_last_viewed_job(req.sessionId))


def _has_generation_evidence(session) -> bool:
    has_identity = bool(session.resume.personal.name or session.resume.personal.email)
    has_core = bool(session.resume.education and session.resume.skills)
    has_proof = bool(session.resume.projects or session.resume.experience)
    return has_identity and has_core and has_proof


def _analysis_type(text: str) -> str | None:
    normalized = (text or "").strip().lower()
    if "resume" not in normalized and "cv" not in normalized:
        return None
    if any(term in normalized for term in ("gap", "missing", "compare")):
        return "gap"
    if any(term in normalized for term in ("score", "rate", "ats", "match analysis", "analyze", "analyse")):
        return "score"
    return None


def _resume_source(req: QueryRequest, session) -> tuple[str, dict]:
    if session.latex:
        return session.latex, {"title": "Current generated resume", "version": None}
    meta = req.meta_data if isinstance(req.meta_data, dict) else {}
    journey_resume = meta.get("resume")
    if isinstance(journey_resume, str) and journey_resume.strip():
        return journey_resume, {"title": "Current generated resume", "version": None}
    latest = meta.get("latest_resume") if isinstance(meta.get("latest_resume"), dict) else {}
    source = latest.get("latexCode")
    return (source if isinstance(source, str) else ""), latest


def _extract_json_block(text: str) -> dict | None:
    """Try to extract a JSON object from an LLM response that may contain prose."""
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(0))
        except json.JSONDecodeError:
            pass
    return None


def _resume_to_dict(session) -> dict:
    """Serialize the session's ResumeData to a plain dict for the LLM prompt."""
    r = session.resume
    return {
        "personal": r.personal.model_dump(),
        "education": [e.model_dump() for e in r.education],
        "experience": [e.model_dump() for e in r.experience],
        "projects": [p.model_dump() for p in r.projects],
        "skills": r.skills,
        "achievements": [a.model_dump() for a in r.achievements],
        "certifications": [c.model_dump() for c in r.certifications],
        "positions": [p.model_dump() for p in r.positions],
        "languages": [la.model_dump() for la in r.languages],
        "section_flags": {k: v.value for k, v in session.section_flags.items()},
    }


def _sync_profile_flags(session) -> None:
    """Keep readiness flags aligned with profile-seeded resume data."""
    session.has_skills = bool(session.resume.skills)
    session.has_projects = bool(session.resume.projects)
    session.has_experience = bool(session.resume.experience)
    if session.resume.achievements:
        session.mark_section("achievements", SectionStatus.PROVIDED)
    if session.resume.certifications:
        session.mark_section("certifications", SectionStatus.PROVIDED)


def _update_session_from_llm_json(session, data: dict) -> None:
    """Apply structured updates from an LLM JSON block to the session state.

    The LLM may return a partial JSON with updated fields. We merge them in
    rather than replacing the entire resume, so earlier data is preserved.
    """
    from app.agents.resume_generator.schemas import (
        AchievementEntry,
        CertificationEntry,
        EducationEntry,
        ExperienceEntry,
        LanguageEntry,
        PersonalInfo,
        PositionEntry,
        ProjectEntry,
    )

    r = session.resume

    if "personal" in data and isinstance(data["personal"], dict):
        p = data["personal"]
        for field in ["name", "email", "phone", "location", "linkedin", "github", "portfolio"]:
            val = p.get(field, "")
            if val:
                setattr(r.personal, field, normalize_profile_url(val) if field in {"linkedin", "github", "portfolio"} else val)

    if "education" in data and isinstance(data["education"], list):
        for edu in data["education"]:
            r.education.append(EducationEntry(**{k: str(v) for k, v in edu.items()}))

    if "experience" in data and isinstance(data["experience"], list):
        for exp in data["experience"]:
            desc = exp.get("description", [])
            if isinstance(desc, str):
                desc = [desc]
            r.experience.append(ExperienceEntry(
                company=exp.get("company", ""),
                role=exp.get("role", ""),
                duration=exp.get("duration", ""),
                description=desc,
            ))
        session.has_experience = bool(r.experience)

    if "projects" in data and isinstance(data["projects"], list):
        for proj in data["projects"]:
            desc = proj.get("description", [])
            if isinstance(desc, str):
                desc = [desc]
            r.projects.append(ProjectEntry(
                name=proj.get("name", ""),
                tech_stack=proj.get("tech_stack", ""),
                description=desc,
                link=proj.get("link", ""),
            ))
        session.has_projects = bool(r.projects)

    if "skills" in data and isinstance(data["skills"], list):
        r.skills = [str(s) for s in data["skills"] if s]
        session.has_skills = bool(r.skills)

    if "achievements" in data and isinstance(data["achievements"], list):
        for ach in data["achievements"]:
            r.achievements.append(AchievementEntry(
                title=ach.get("title", ""),
                description=ach.get("description", ""),
            ))
        if r.achievements:
            session.mark_section("achievements", SectionStatus.PROVIDED)

    if "certifications" in data and isinstance(data["certifications"], list):
        for cert in data["certifications"]:
            r.certifications.append(CertificationEntry(
                name=cert.get("name", ""),
                issuer=cert.get("issuer", ""),
                year=str(cert.get("year", "")),
            ))
        if r.certifications:
            session.mark_section("certifications", SectionStatus.PROVIDED)

    if "positions" in data and isinstance(data["positions"], list):
        for pos in data["positions"]:
            r.positions.append(PositionEntry(
                role=pos.get("role", ""),
                organization=pos.get("organization", ""),
                duration=pos.get("duration", ""),
                description=pos.get("description", ""),
            ))
        if r.positions:
            session.mark_section("positions", SectionStatus.PROVIDED)

    if "languages" in data and isinstance(data["languages"], list):
        for lang in data["languages"]:
            if isinstance(lang, str):
                r.languages.append(LanguageEntry(language=lang))
            elif isinstance(lang, dict):
                r.languages.append(LanguageEntry(
                    language=lang.get("language", ""),
                    proficiency=lang.get("proficiency", ""),
                ))
        if r.languages:
            session.mark_section("languages", SectionStatus.PROVIDED)

    # Section skip flags from LLM
    for sec in ["achievements", "certifications", "positions", "languages"]:
        flag = data.get(f"{sec}_skipped")
        if flag is True:
            session.mark_section(sec, SectionStatus.SKIPPED)


# ---------------------------------------------------------------------------
# The Agent
# ---------------------------------------------------------------------------


class ResumeGeneratorAgent:
    """Resume Generator Agent — collects resume info conversationally,
    then streams LaTeX to the frontend."""

    name = "resume-generator"

    ROUTING_RULES = RoutingRules(
        strong=(
            r"\b(build|make|create|generate|write|update|edit|improve|fix|redo)\b[^.?!]{0,20}\b(resume|cv)\b",
            r"\bresume\s+(builder|generator|maker)\b",
            r"\b(tailor|score|rate|analy[sz]e|compare)\b[^.?!]{0,35}\b(resume|cv)\b",
            r"\b(resume|cv)\b[^.?!]{0,35}\b(score|gap|analysis|match)\b",
            r"\bgap\s+analysis\b[^.?!]{0,45}\b(resume|cv)\b",
        ),
        weak=(r"\bresumes?\b", r"\bcv\b", r"\blatex\b"),
        veto=(r"\bmock\s+interview\b",),
    )
    SWITCH_MESSAGE = "Sure -- let's work on your resume."

    # run() yields ResumeChunk objects, which carry their own wire format.
    emits_own_chunks = True
    content_header = RESUME_HEADER_MESSAGE

    @staticmethod
    def error_chunk(message: str, session_id: str = "") -> ResumeChunk:
        return ResumeChunk.error(message, session_id=session_id)

    async def run(self, req: QueryRequest) -> AsyncIterator[Any]:
        session = get_or_create_session(req.sessionId)
        sid = req.sessionId
        incoming_target = _selected_job(req)
        if incoming_target:
            session.target_job = incoming_target
        tailoring_requested = _user_requests_job_tailoring(req.user_query)
        requested_analysis = _analysis_type(req.user_query)

        try:
            if requested_analysis:
                session.resume, _ = seed_resume_from_profile(req, session.resume)
                _sync_profile_flags(session)
                source, resume_record = _resume_source(req, session)
                if not session.target_job and isinstance(resume_record.get("targetJob"), dict):
                    session.target_job = normalize_target_job(resume_record.get("targetJob"))
                if not source.strip():
                    yield ResumeChunk.text(
                        "Generate or save a resume first, then ask me to score it or compare it with the discussed job.",
                        session_id=sid,
                        is_end=True,
                    )
                    return
                if requested_analysis == "gap" and not session.target_job:
                    yield ResumeChunk.text(
                        "Ask me about a specific job first, then I can compare that job with your resume.",
                        session_id=sid,
                        is_end=True,
                    )
                    return
                result = await analyze_resume(
                    resume_source=source,
                    resume_data=_resume_to_dict(session),
                    target_job=session.target_job,
                    analysis_type=requested_analysis,
                    resume_record=resume_record,
                )
                save_session(sid, session)
                yield ResumeChunk.analysis(result, session_id=sid)
                return

            # ------------------------------------------------------------------
            # PHASE: GENERATING — user explicitly triggered generation
            # ------------------------------------------------------------------
            if session.status == SessionStatus.GENERATING:
                async for chunk in self._stream_generation(session, sid, req.requestId):
                    yield chunk
                save_session(sid, session)
                return

            # ------------------------------------------------------------------
            # PHASE: EDITING — post-generation edit request
            # ------------------------------------------------------------------
            if session.status == SessionStatus.EDITING:
                # Seed any newly provided profile data (e.g. GitHub link added)
                session.resume, clean_msg = seed_resume_from_profile(req, session.resume)
                _sync_profile_flags(session)

                if tailoring_requested and not session.target_job:
                    yield ResumeChunk.text(
                        "Select a job card first so I can tailor the existing resume to its real requirements.",
                        session_id=sid,
                        is_end=True,
                    )
                    save_session(sid, session)
                    return

                # Check if user wants to regenerate from scratch
                if _user_wants_to_generate(clean_msg) and not session.latex:
                    session.status = SessionStatus.GENERATING
                    async for chunk in self._stream_generation(session, sid, req.requestId):
                        yield chunk
                    save_session(sid, session)
                    return

                async for chunk in self._stream_edit(session, sid, req.requestId, clean_msg):
                    yield chunk
                save_session(sid, session)
                return

            # ------------------------------------------------------------------
            # PHASE: COLLECTING — default
            # ------------------------------------------------------------------
            # Seed resume from any inline profile JSON
            session.resume, clean_msg = seed_resume_from_profile(req, session.resume)
            _sync_profile_flags(session)

            if tailoring_requested and not session.target_job:
                yield ResumeChunk.text(
                    "Select a job card first so I can tailor the resume to its real requirements.",
                    session_id=sid,
                    is_end=True,
                )
                save_session(sid, session)
                return

            if tailoring_requested and session.target_job and _has_generation_evidence(session):
                session.status = SessionStatus.GENERATING
                target_title = session.target_job.get("title") or "the selected role"
                target_company = session.target_job.get("company") or "the target company"
                yield ResumeChunk.text(
                    f"I’ll tailor your resume for {target_title} at {target_company}, using only evidence already present in your profile.",
                    session_id=sid,
                    is_end=False,
                )
                async for chunk in self._stream_generation(session, sid, req.requestId):
                    yield chunk
                save_session(sid, session)
                return

            # User may say "generate it" at any point
            if _user_wants_to_generate(clean_msg) and session.is_ready_to_generate():
                session.status = SessionStatus.GENERATING
                yield ResumeChunk.text(
                    "Perfect! Generating your resume now. This may take a moment... ✨",
                    session_id=sid,
                    is_end=False,
                )
                await asyncio.sleep(0.05)
                async for chunk in self._stream_generation(session, sid, req.requestId):
                    yield chunk
                save_session(sid, session)
                return

            # Otherwise: conversational collection
            async for chunk in self._collect(session, sid, req.requestId, clean_msg):
                yield chunk
            save_session(sid, session)

        except Exception as exc:
            log.exception("[%s] resume agent error", req.requestId)
            yield ResumeChunk.text(
                f"Something went wrong while processing your request: {exc}",
                session_id=sid,
                is_end=True,
            )

    # ------------------------------------------------------------------
    # Internal: collection phase
    # ------------------------------------------------------------------

    async def _collect(self, session, sid: str, request_id: str, user_message: str):
        """Call Gemini conversationally, parse its reply, update session."""

        # Detect skip intent for optional sections
        user_lower = user_message.strip().lower()
        for sec in ["achievements", "certifications", "positions", "languages"]:
            if sec in user_lower and _user_wants_to_skip(user_message):
                session.mark_section(sec, SectionStatus.SKIPPED)

        # Build the user turn with current resume state
        resume_dict = _resume_to_dict(session)
        tailoring_context = build_tailoring_context(resume_dict, session.target_job)
        user_turn = build_collect_user_turn(resume_dict, user_message, tailoring_context)

        # --- Token compaction ------------------------------------------------
        # Compact older history turns into a summary before the LLM call.
        # Safe-fails: if compaction errors, history is left untouched.
        await maybe_compact(session)
        compact_history = build_compact_history(session)
        # ---------------------------------------------------------------------

        full_reply = ""
        json_data = None

        # Call Gemini and stream response — uses compact history, not raw history
        async for chunk, extracted_json in stream_and_extract_json(
            system_prompt=SYSTEM_PROMPT_COLLECT,
            history=compact_history,
            user_turn=user_turn,
        ):
            if extracted_json is not None:
                # Stream finished
                full_reply = chunk
                if extracted_json:
                    try:
                        json_data = json.loads(extracted_json)
                    except Exception:
                        pass
            elif chunk:
                # Conversational chunk
                yield ResumeChunk.text(chunk, session_id=sid, is_end=False)
                await asyncio.sleep(0.01)

        # Update history
        session.append_history("user", user_turn)
        session.append_history("model", full_reply)

        if json_data:
            _update_session_from_llm_json(session, json_data)

        # Clean reply for internal checks
        reply_no_json = re.sub(r"```json.*?```", "", full_reply, flags=re.DOTALL)
        reply_no_json = re.sub(r"\{.*?\}", "", reply_no_json, flags=re.DOTALL).strip()

        # Check if LLM signalled readiness to generate
        if "READY_TO_GENERATE" in reply_no_json:
            session.status = SessionStatus.GENERATING
            session.extra_asked = True

            yield ResumeChunk.text(
                "\n\nGreat! Generating your LaTeX resume now... ✨",
                session_id=sid,
                is_end=False,
            )
            await asyncio.sleep(0.02)

            async for chunk in self._stream_generation(session, sid, request_id):
                yield chunk
            return

        # Normal conversational reply end
        if not reply_no_json:
            yield ResumeChunk.text("Could you tell me a bit more about yourself?", session_id=sid, is_end=True)
        else:
            yield ResumeChunk.text("", session_id=sid, is_end=True)

    # ------------------------------------------------------------------
    # Internal: LaTeX generation phase
    # ------------------------------------------------------------------

    async def _stream_generation(self, session, sid: str, request_id: str):
        """Stream LaTeX from Gemini and yield ResumeChunk(type='latex') objects."""
        resume_dict = _resume_to_dict(session)

        # Filter out skipped sections before generating
        for sec in ["achievements", "certifications", "positions", "languages"]:
            if session.section_flags.get(sec) == SectionStatus.SKIPPED:
                resume_dict[sec] = []

        tailoring_context = build_tailoring_context(resume_dict, session.target_job)
        user_turn = build_generate_user_turn(resume_dict, tailoring_context)
        accumulated_latex = ""

        async for text_chunk in stream_gemini_text(
            system_prompt=SYSTEM_PROMPT_GENERATE,
            history=[],  # fresh context — no chat history for generation
            user_turn=user_turn,
        ):
            accumulated_latex += text_chunk
            yield ResumeChunk.latex(text_chunk, session_id=sid, is_end=False)
            await asyncio.sleep(0.01)

        # Save the complete LaTeX
        session.latex = accumulated_latex
        session.status = SessionStatus.EDITING  # subsequent messages are edits

        # Final chunk
        yield ResumeChunk(
            type="latex",
            response="Your resume has been generated successfully! You can now ask me to make any changes.",
            data={
                "type": "latex",
                "content": "",
                "status": "complete",
                "target_job": session.target_job,
            },
            is_end=True,
            session_id=sid,
        )

    # ------------------------------------------------------------------
    # Internal: editing phase
    # ------------------------------------------------------------------

    async def _stream_edit(self, session, sid: str, request_id: str, edit_instruction: str):
        """Apply a natural-language edit and re-stream the updated LaTeX."""
        if not session.latex:
            # No existing LaTeX — fallback to generation
            yield ResumeChunk.text(
                "It looks like there's no resume generated yet. Let me generate one first.",
                session_id=sid,
                is_end=False,
            )
            await asyncio.sleep(0.05)
            async for chunk in self._stream_generation(session, sid, request_id):
                yield chunk
            return

        resume_dict = _resume_to_dict(session)
        tailoring_context = build_tailoring_context(resume_dict, session.target_job)
        user_turn = build_edit_user_turn(
            session.latex,
            edit_instruction,
            resume_data_dict=resume_dict,
            tailoring_context=tailoring_context,
        )
        accumulated_latex = ""

        async for text_chunk in stream_gemini_text(
            system_prompt=SYSTEM_PROMPT_EDIT,
            history=[],  # fresh context for editing
            user_turn=user_turn,
        ):
            accumulated_latex += text_chunk
            yield ResumeChunk.latex(text_chunk, session_id=sid, is_end=False)
            await asyncio.sleep(0.01)

        session.latex = accumulated_latex

        yield ResumeChunk(
            type="latex",
            response="Done! Your resume has been updated.",
            data={
                "type": "latex",
                "content": "",
                "status": "complete",
                "target_job": session.target_job,
            },
            is_end=True,
            session_id=sid,
        )
