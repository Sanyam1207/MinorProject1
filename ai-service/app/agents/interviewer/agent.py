"""AI Interviewer Agent.

Registered in ``app/agents/__init__.py`` under the name ``"ai-interviewer"``.

Architecture
------------
Natural language on top     -> Gemini writes questions and scores the transcript
Explicit state in the middle -> InterviewSessionState (stage, transcript, clock)
Deterministic control below  -> this module decides stage transitions

Gemini never decides which stage the session is in, whether the candidate
asked to stop, or whether the time/question budget has run out. Those are
checked here, so a misread answer cannot skip required setup or make the
interview exceed its configured length.

Turn flow
---------
1.  First turn        -> the two entry options            (``button:options``)
2a. Option 1 picked   -> ask for the job link             (``select:job:db``)
                         then fetch + extract the job details
2b. Option 2 picked   -> read the profile from meta_data
3.  Use profile name, or ask only when it is missing      (``text:mode:interview``)
4.  Q/A loop          -> one question per turn            (``text:mode:interview``)
5.  End               -> candidate asks to stop, 4-5 questions are complete,
                         or the clock runs out             (``interview:end``)
                         and the scored report is attached to that last chunk.
"""

from __future__ import annotations

import logging
import re
from typing import Any, AsyncIterator, Dict, List, Optional, Tuple

from app.config import settings
from app.schemas import QueryRequest
from app.agents.routing import DESIRE_RE, NARRATIVE_START_RE, RoutingRules

from app.agents.interviewer.context import (
    build_job_context,
    build_job_context_from_dict,
    build_profile_context,
    find_job_in_metadata,
    profile_is_usable,
)
from app.agents.interviewer.llm import call_gemini_json
from app.agents.interviewer.prompt import (
    SYSTEM_PROMPT_NAME,
    SYSTEM_PROMPT_QUESTION,
    build_name_user_turn,
    build_question_user_turn,
)
from app.agents.interviewer.report import format_report_markdown, generate_report
from app.agents.interviewer.schemas import (
    InterviewChunk,
    InterviewSource,
    InterviewStage,
    QAPair,
)
from app.agents.interviewer.session import (
    InterviewSessionState,
    delete_session,
    get_or_create_session,
    reset_session,
    save_session,
)

log = logging.getLogger("interviewer.agent")


# ---------------------------------------------------------------------------
# Deterministic intent detection
#
# Every pattern below is anchored on word boundaries. Substring matching
# ("no" inside "Nokia", "ready" inside "already") silently corrupts a
# conversational agent, so it is avoided here on purpose.
# ---------------------------------------------------------------------------

_URL_RE = re.compile(r"https?://[^\s<>\"']+")

_END_RE = re.compile(
    r"\b(end|finish|stop|quit|exit|conclude|wrap\s*up|"
    r"that'?s\s+(it|all)|i'?m\s+done|no\s+more\s+questions?)\b",
    re.IGNORECASE,
)
_INTERVIEW_WORD_RE = re.compile(r"\b(interview|session|round)\b", re.IGNORECASE)

_RESTART_RE = re.compile(
    r"\b(new|another|again|restart|re-?start|start\s+over|one\s+more)\b", re.IGNORECASE
)

_JOB_CHOICE_RE = re.compile(
    r"\b(job|role|position|posting|vacancy|opening|link|jd)\b", re.IGNORECASE
)
_PROFILE_CHOICE_RE = re.compile(
    r"\b(profile|resume|cv|general|generic|my\s+skills)\b", re.IGNORECASE
)

_NAME_SHAPE_RE = re.compile(r"^[A-Za-z][A-Za-z.'\-]*(?:\s+[A-Za-z][A-Za-z.'\-]*){0,3}$")

# Backstop for releasing a live interview to another agent. The router's own
# judgement is a prompt instruction, so it can misfire: an answer like "I built
# a job board with React" mentions jobs and could be read as a request to go
# job-hunting. Losing a half-finished interview to that is expensive, so a
# switch also has to look like one of these -- either the candidate walking
# away from the interview, or an instruction aimed at the assistant rather than
# a description of their own work.
_ABANDON_RE = re.compile(
    r"\b(instead|actually|never\s?mind|nevermind|forget\s+(this|it|that)|"
    r"switch|change\s+to|go\s+back\s+to|"
    r"(stop|cancel|quit|leave|exit|skip|pause)\s+(the\s+|this\s+|my\s+)?interview)\b",
    re.IGNORECASE,
)
_ASSISTANT_REQUEST_RE = re.compile(
    r"\b(find|search|show|get|give|fetch|build|make|create|generate|post|check|look|help)\s+"
    r"(me|my|us|for|a|an|the)\b",
    re.IGNORECASE,
)

# Subject matter that belongs to one of the other agents, not to an interview.
_OTHER_MODE_NOUN_RE = re.compile(
    r"\b(jobs?|vacanc(y|ies)|opening|openings|internships?|"
    r"resume|cv|eligib(le|ility)|placement)\b",
    re.IGNORECASE,
)

# An instruction aimed at the assistant, with the usual polite lead-ins.
_IMPERATIVE_START_RE = re.compile(
    r"^\s*(?:can\s+you\s+|could\s+you\s+|please\s+|pls\s+|"
    r"i\s+want\s+to\s+|i\s+wanna\s+|i\s+need\s+to\s+|let'?s\s+)?"
    r"(find|search|show|get|give|fetch|build|make|create|generate|post|check|look|help|open|go)\b",
    re.IGNORECASE,
)

# The candidate talking about themselves -- the shape of an interview answer.
_FIRST_PERSON_RE = re.compile(r"\b(i|i'?m|i'?ve|i'?d|my|mine|we|we'?ve|our|me)\b", re.IGNORECASE)

# Narration vs instruction is a general routing concern, so the patterns live
# in app.agents.routing and are shared with the orchestrator's switch check.
_NARRATIVE_START_RE = NARRATIVE_START_RE
_DESIRE_RE = DESIRE_RE

# Explicit values the UI buttons can post back
_JOB_VALUES = {"job", "option_1", "option1", "1", "option 1"}
_PROFILE_VALUES = {"profile", "option_2", "option2", "2", "option 2"}

# Replies to "shall I stop the interview and switch you over?"
_CONFIRM_SWITCH_RE = re.compile(
    r"\b(yes|yeah|yep|yup|sure|ok|okay|correct|right|"
    r"please\s+do|do\s+it|go\s+ahead|switch|quit|leave|exit)\b",
    re.IGNORECASE,
)
_DECLINE_SWITCH_RE = re.compile(
    r"\b(no|nope|nah|continue|carry\s+on|keep\s+going|stay|resume\s+the|"
    r"back\s+to\s+the\s+interview)\b",
    re.IGNORECASE,
)

# How the other agents are described to the candidate.
_MODE_LABELS = {
    "jobs-finder": "job search",
    "resume-generator": "resume builder",
    "job-eligibility": "eligibility checker",
    "job-creation": "job posting tool",
    "pr-outreach": "outreach email drafting",
    "alumni-connect": "alumni mentor matching",
    "gap-analysis": "curriculum gap analysis",
    "learning-recommendation": "learning plan",
    "copilot": "campus assistant",
}

_FALLBACK_FIRST_QUESTION = (
    "Thanks for that. To get us started -- walk me through something you have "
    "built recently, and what your part in it was."
)
_FALLBACK_QUESTION = (
    "Thanks. Let's take a different angle -- tell me about a technical problem "
    "you got stuck on recently, and how you worked through it."
)


def _extract_url(text: str) -> str:
    match = _URL_RE.search(text or "")
    return match.group(0).rstrip(".,;)'\"") if match else ""


def wants_to_end(text: str) -> bool:
    """True when the candidate is asking to stop, not answering a question.

    Short messages need only the stop phrase. Longer ones must also name the
    interview, so an answer that happens to contain "I finish the task by..."
    is not mistaken for a command.
    """
    stripped = (text or "").strip()
    if not stripped or len(stripped) > 120:
        return False
    if not _END_RE.search(stripped):
        return False
    if len(stripped) <= 60:
        return True
    return bool(_INTERVIEW_WORD_RE.search(stripped))


def wants_new_interview(text: str) -> bool:
    stripped = (text or "").strip()
    return len(stripped) <= 120 and bool(_RESTART_RE.search(stripped))


def detect_choice(text: str) -> Optional[InterviewSource]:
    """Work out which of the two entry options the candidate picked."""
    stripped = (text or "").strip()
    if not stripped:
        return None

    lowered = stripped.lower()
    if lowered in _JOB_VALUES:
        return InterviewSource.JOB
    if lowered in _PROFILE_VALUES:
        return InterviewSource.PROFILE

    # A pasted link is unambiguous -- it can only be option 1.
    if _extract_url(stripped):
        return InterviewSource.JOB

    wants_profile = bool(_PROFILE_CHOICE_RE.search(stripped))
    wants_job = bool(_JOB_CHOICE_RE.search(stripped))
    if wants_profile and not wants_job:
        return InterviewSource.PROFILE
    if wants_job and not wants_profile:
        return InterviewSource.JOB
    return None


def extract_extra_condition(text: str, url: str = "") -> str:
    """Whatever the candidate asked for beyond picking an option.

    Best-effort: the message minus any URL, kept only when it carries enough
    substance to be a real instruction ("keep it focused on system design").
    """
    remainder = (text or "").replace(url, " ") if url else (text or "")
    remainder = re.sub(r"\s+", " ", remainder).strip(" .,-")
    if len(remainder) < 20:
        return ""
    return remainder


# ---------------------------------------------------------------------------
# The Agent
# ---------------------------------------------------------------------------


class InterviewerAgent:
    """Conducts a time-boxed mock interview and scores it."""

    name = "ai-interviewer"

    ROUTING_RULES = RoutingRules(
        strong=(
            r"\bmock\s+interview\b",
            r"\b(give|take|do|start|begin|have|conduct|practi[cs]e)\b[^.?!]{0,20}\binterview\b",
            r"\binterview\s+me\b",
            r"\bprepare\s+for\b[^.?!]{0,20}\binterview\b",
            r"\binterview\s+(practice|prep|preparation|round|session)\b",
        ),
        weak=(r"\binterviews?\b",),
    )
    SWITCH_MESSAGE = "Sure -- let's run a mock interview."

    # run() yields InterviewChunk objects, which carry their own wire format.
    emits_own_chunks = True
    content_header = InterviewChunk.HEADER_INTERVIEW

    @staticmethod
    def error_chunk(message: str, session_id: str = "") -> InterviewChunk:
        return InterviewChunk.error_chunk(response=message, session_id=session_id)

    async def run(self, req: QueryRequest) -> AsyncIterator[Any]:
        sid = req.sessionId
        state = get_or_create_session(sid)
        message = (req.user_query or "").strip()

        try:
            async for chunk in self._handle(req, state, sid, message):
                yield chunk
        except Exception as exc:
            log.exception("[%s] interviewer agent failed", req.requestId)
            yield InterviewChunk.error_chunk(
                response=f"Something went wrong during the interview: {exc}",
                session_id=sid,
            )
        finally:
            save_session(sid, state)

    # -- mode exit --------------------------------------------------------

    async def pending_switch(self, req: QueryRequest) -> Optional[tuple[str, str]]:
        """Complete a switch the candidate was asked to confirm last turn.

        Returns ``(target_mode, original_query)`` when they said yes -- the
        original query, not "yes", so the receiving agent gets the request the
        candidate actually made. Returns None in every other case.
        """
        state = get_or_create_session(req.sessionId)
        if not state.awaiting_switch_confirmation:
            return None

        text = (req.user_query or "").strip()
        target = state.pending_switch_target
        original = state.pending_switch_query or text

        if _CONFIRM_SWITCH_RE.search(text) and not _DECLINE_SWITCH_RE.search(text):
            state.clear_pending_switch()
            save_session(req.sessionId, state)
            log.info("session %s: candidate confirmed the switch to %s", req.sessionId, target)
            return target, original

        if _DECLINE_SWITCH_RE.search(text):
            state.clear_pending_switch()
            state.declined_switch = True
            save_session(req.sessionId, state)
            log.info("session %s: candidate declined the switch, resuming", req.sessionId)
            return None

        # Neither yes nor no -- they simply carried on answering. Drop the
        # question and let this turn be handled as a normal answer.
        state.clear_pending_switch()
        save_session(req.sessionId, state)
        return None

    async def should_release(self, req: QueryRequest, target: str = "") -> str:
        """Decide what to do when the router wants to reroute a live interview.

        Returns one of:

        ``"release"`` -- the candidate clearly means to leave, so switch
                         straight away without pestering them.
        ``"ask"``     -- the router and the message disagree. Rather than
                         silently guessing either way, the interview is held
                         for one turn while the candidate is asked outright.
        ``"hold"``    -- nothing to protect, or nothing to ask about.

        This is only ever consulted once the router has already decided a
        switch is wanted, so it can never cause one on its own.
        """
        state = get_or_create_session(req.sessionId)
        if state.stage not in (InterviewStage.AWAITING_NAME, InterviewStage.IN_PROGRESS):
            return "release"

        text = (req.user_query or "").strip()
        if text and self._reads_as_exit(text):
            return "release"

        # The router read this as a request to leave; the wording reads as an
        # answer. That disagreement is exactly the confusion worth one question
        # -- guessing "hold" loses their request, guessing "release" loses
        # their interview.
        state.awaiting_switch_confirmation = True
        state.pending_switch_target = target
        state.pending_switch_query = text
        save_session(req.sessionId, state)
        log.info(
            "session %s: ambiguous exit %r -- asking before switching to %s",
            req.sessionId, text[:80], target or "another mode",
        )
        return "ask"

    @staticmethod
    def _reads_as_exit(text: str) -> bool:
        """Does this message look like leaving, rather than answering?

        The distinguishing feature is not the subject matter -- an answer may
        legitimately be about jobs or resumes -- but who it is about. A
        candidate describing their own work says "I"; someone giving the
        assistant an instruction does not.
        """
        # An explicit abandonment always wins, first person or not:
        # "stop the interview and build my resume".
        if _ABANDON_RE.search(text):
            return True

        # "I want to find jobs" is first person, but it is still a request.
        asking = bool(_DESIRE_RE.match(text))

        # The candidate narrating their own work. Checked before any
        # instruction pattern, because an answer can easily contain one --
        # "I would create a job queue" is not a request to create anything.
        if _NARRATIVE_START_RE.match(text) and not asking:
            return False

        # A direct instruction: "find me jobs", "build my resume", "post a job".
        if _ASSISTANT_REQUEST_RE.search(text):
            return True

        # Otherwise it has to be about another agent's subject at all.
        if not _OTHER_MODE_NOUN_RE.search(text):
            return False

        # ...and must not be the candidate talking about themselves, which is
        # what "in my resume project" and "our eligibility checker" are.
        if _FIRST_PERSON_RE.search(text) and not asking:
            return False

        # A bare topic word ("jobs"), a terse command ("find jobs"), or a
        # longer explicit instruction ("search for backend openings in Pune").
        return len(text) <= 60 or bool(_IMPERATIVE_START_RE.match(text))

    async def on_mode_exit(self, req: QueryRequest) -> Optional[str]:
        """The orchestrator is rerouting this session to a different agent.

        An interview cannot be left running in the background -- the clock is
        ticking and the next turn would be scored as an answer -- so the session
        is torn down here. Returns a short notice the orchestrator prepends to
        the mode-switch line, or None when there was no interview to end.
        """
        state = get_or_create_session(req.sessionId)
        was_live = state.stage in (
            InterviewStage.AWAITING_NAME,
            InterviewStage.IN_PROGRESS,
        )
        answered = len(state.answered_pairs())
        delete_session(req.sessionId)

        if not was_live:
            return None

        log.info(
            "interview for session %s terminated by a mode switch after %d answer(s)",
            req.sessionId, answered,
        )
        if answered:
            return (
                f"I've ended your mock interview there -- we got through "
                f"{answered} question(s), and it wasn't scored since we stopped early."
            )
        return "I've ended your mock interview there."

    # -- dispatch ---------------------------------------------------------

    async def _handle(
        self,
        req: QueryRequest,
        state: InterviewSessionState,
        sid: str,
        message: str,
    ) -> AsyncIterator[Any]:
        # A switch was proposed this turn but the wording was ambiguous -- ask
        # before doing anything, and leave the transcript untouched so the
        # interview can resume exactly where it was.
        if state.awaiting_switch_confirmation:
            yield self._ask_about_switching(state, sid)
            return

        # They said no to that question: pick the interview back up.
        if state.declined_switch:
            state.declined_switch = False
            yield self._resume_after_decline(state, sid)
            return

        if state.stage == InterviewStage.ENDED:
            async for chunk in self._after_end(req, state, sid, message):
                yield chunk
            return

        if state.stage == InterviewStage.CHOOSING:
            async for chunk in self._choose(req, state, sid, message):
                yield chunk
            return

        if state.stage == InterviewStage.AWAITING_JOB_LINK:
            async for chunk in self._receive_job_link(req, state, sid, message):
                yield chunk
            return

        if state.stage == InterviewStage.AWAITING_NAME:
            async for chunk in self._receive_name(state, sid, message):
                yield chunk
            return

        async for chunk in self._interview_turn(state, sid, message):
            yield chunk

    # -- ambiguous exit: ask rather than guess ----------------------------

    def _ask_about_switching(self, state: InterviewSessionState, sid: str) -> InterviewChunk:
        """Ask outright whether to abandon the interview and switch."""
        label = _MODE_LABELS.get(state.pending_switch_target, "something else")
        return InterviewChunk(
            header_message=InterviewChunk.HEADER_INTERVIEW,
            response=(
                f"Just to check before I do anything -- did you want to stop the "
                f"interview and switch over to the {label}, or shall we carry on "
                f"with the interview?"
            ),
            data={
                "type": "switch_confirmation",
                "target_mode": state.pending_switch_target,
                "options": [
                    {"label": f"Switch to the {label}", "value": "yes"},
                    {"label": "Carry on with the interview", "value": "no"},
                ],
            },
            is_end=True,
            session_id=sid,
        )

    def _resume_after_decline(self, state: InterviewSessionState, sid: str) -> InterviewChunk:
        """They chose to stay -- re-ask the question that was already pending."""
        pending = state.pending_question
        if pending is None:
            return InterviewChunk(
                header_message=InterviewChunk.HEADER_INTERVIEW,
                response="Good -- let's keep going. Tell me a bit more about your last answer.",
                data={"type": "interview_question", "topic": "General",
                      "seconds_remaining": state.seconds_remaining()},
                is_end=True,
                session_id=sid,
            )
        return InterviewChunk.question_chunk(
            response=f"Good, let's carry on then.\n\n{pending.question}",
            question_number=len(state.qa) + 1,
            topic=pending.topic,
            is_follow_up=pending.is_follow_up,
            seconds_remaining=state.seconds_remaining(),
            session_id=sid,
        )

    # -- stage: after a finished interview --------------------------------

    async def _after_end(
        self, req: QueryRequest, state: InterviewSessionState, sid: str, message: str
    ) -> AsyncIterator[Any]:
        """A finished session only accepts starting a fresh interview.

        The state is reset in place -- ``run()`` saves this same object when the
        turn ends, so a replacement object would simply be overwritten and the
        candidate would be stuck on the options screen forever.
        """
        state.reset()
        fresh = state
        if wants_new_interview(message) or not message:
            yield InterviewChunk.options_chunk(
                response="Let's run another one. How would you like to practise this time?",
                session_id=sid,
            )
            return
        # Any other message: treat it as the start of a new interview.
        async for chunk in self._choose(req, fresh, sid, message):
            yield chunk

    # -- stage: pick an option --------------------------------------------

    async def _choose(
        self,
        req: QueryRequest,
        state: InterviewSessionState,
        sid: str,
        message: str,
    ) -> AsyncIterator[Any]:
        choice = detect_choice(message)

        if choice is None:
            yield InterviewChunk.options_chunk(
                response=(
                    "Happy to run a mock interview with you. How would you like "
                    "to practise?"
                ),
                session_id=sid,
            )
            return

        if choice == InterviewSource.JOB:
            state.source = InterviewSource.JOB
            # The authenticated profile accompanies every student request. Keep
            # it even for a job-based interview so the candidate's known name
            # does not have to be collected again after the job is loaded.
            state.profile = build_profile_context(req.meta_data)
            url = _extract_url(message)
            condition = extract_extra_condition(message, url)
            if condition:
                state.extra_conditions = condition

            # Check if a database job was chosen or passed in metadata/query
            db_job = find_job_in_metadata(message, req.meta_data)
            if db_job is not None:
                state.job = db_job
                async for chunk in self._begin_with_profile_name_or_ask(state, sid):
                    yield chunk
                return

            if not url:
                state.stage = InterviewStage.AWAITING_JOB_LINK
                yield InterviewChunk.select_job_chunk(
                    response=(
                        "Good choice. Pick the job you want to practise for from "
                        "the list, or paste its link here and I'll pull the details."
                    ),
                    session_id=sid,
                )
                return

            async for chunk in self._load_job(state, sid, url, message):
                yield chunk
            return

        # Option 2 -- interview from the candidate's own profile
        state.source = InterviewSource.PROFILE
        condition = extract_extra_condition(message)
        if condition:
            state.extra_conditions = condition

        profile = build_profile_context(req.meta_data)
        if not profile_is_usable(profile):
            state.source = None
            yield InterviewChunk.error_chunk(
                response=(
                    "I couldn't find enough in your profile to interview you on -- "
                    "I need at least some skills, projects or experience there. "
                    "Add those to your profile, or pick a job from the database "
                    "and we'll practise for that role instead."
                ),
                session_id=sid,
            )
            return

        state.profile = profile
        async for chunk in self._begin_with_profile_name_or_ask(state, sid):
            yield chunk

    # -- stage: receive the job link --------------------------------------

    async def _receive_job_link(
        self,
        req: QueryRequest,
        state: InterviewSessionState,
        sid: str,
        message: str,
    ) -> AsyncIterator[Any]:
        # 1. Check if a DB job was chosen or provided in metadata/query
        db_job = find_job_in_metadata(message, req.meta_data)
        if db_job is not None:
            state.job = db_job
            condition = extract_extra_condition(message)
            if condition:
                state.extra_conditions = condition
            async for chunk in self._begin_with_profile_name_or_ask(state, sid):
                yield chunk
            return

        # 2. Check for a pasted job link URL
        url = _extract_url(message)
        if not url:
            yield InterviewChunk.select_job_chunk(
                response=(
                    "I still need a job to prepare for -- select a job from the list "
                    "or paste the full URL (starting with http:// or https://)."
                ),
                session_id=sid,
            )
            return

        condition = extract_extra_condition(message, url)
        if condition:
            state.extra_conditions = condition

        async for chunk in self._load_job(state, sid, url, message):
            yield chunk

    async def _load_job(
        self,
        state: InterviewSessionState,
        sid: str,
        url: str,
        message: str,
    ) -> AsyncIterator[Any]:
        """Fetch + extract the job details, then move on to the name step."""
        job, error = await build_job_context(url, user_hint=message)
        if job is None:
            state.stage = InterviewStage.AWAITING_JOB_LINK
            yield InterviewChunk.select_job_chunk(response=error, session_id=sid)
            return

        state.job = job
        async for chunk in self._begin_with_profile_name_or_ask(state, sid):
            yield chunk

    async def _begin_with_profile_name_or_ask(
        self, state: InterviewSessionState, sid: str
    ) -> AsyncIterator[Any]:
        """Start immediately when the authenticated profile already has a name."""
        profile_name = (state.profile.name if state.profile is not None else "").strip()
        if not profile_name:
            state.stage = InterviewStage.AWAITING_NAME
            yield self._ask_for_name(state, sid)
            return

        state.candidate_name = profile_name[:80]
        state.stage = InterviewStage.IN_PROGRESS
        state.start_clock()
        yield await self._ask_next_question(state, sid, is_first=True)

    # -- stage: mandatory name --------------------------------------------

    def _ask_for_name(self, state: InterviewSessionState, sid: str) -> InterviewChunk:
        if state.source == InterviewSource.JOB and state.job is not None:
            lead = (
                f"Great -- we'll run this as an interview for **{state.job.headline()}**"
            )
            if state.job.experience_required != "Not mentioned":
                lead += f" ({state.job.experience_required})"
            lead += "."
        else:
            lead = "Great -- we'll base this on your profile."

        return InterviewChunk(
            header_message=InterviewChunk.HEADER_INTERVIEW,
            response=(
                f"{lead}\n\nBefore we start, could you introduce yourself -- "
                "what's your name?"
            ),
            data={"type": "interview_intro", "awaiting": "name"},
            is_end=True,
            session_id=sid,
        )

    async def _receive_name(
        self, state: InterviewSessionState, sid: str, message: str
    ) -> AsyncIterator[Any]:
        if wants_to_end(message):
            async for chunk in self._finish(state, sid, "the candidate ended before starting"):
                yield chunk
            return

        name = await self._extract_name(message, state)
        if not name:
            yield InterviewChunk(
                header_message=InterviewChunk.HEADER_INTERVIEW,
                response=(
                    "I didn't catch your name there -- could you tell me what to "
                    "call you? We'll start right after that."
                ),
                data={"type": "interview_intro", "awaiting": "name"},
                is_end=True,
                session_id=sid,
            )
            return

        state.candidate_name = name
        state.stage = InterviewStage.IN_PROGRESS
        state.start_clock()

        yield await self._ask_next_question(state, sid, is_first=True)

    async def _extract_name(
        self, message: str, state: InterviewSessionState
    ) -> Optional[str]:
        """Read the candidate's name out of their reply."""
        stripped = message.strip()
        if not stripped:
            return None

        data = await call_gemini_json(
            SYSTEM_PROMPT_NAME,
            build_name_user_turn(stripped),
            temperature=0.0,
            max_output_tokens=64,
            timeout=10.0,
        )
        if data:
            name = data.get("name")
            if isinstance(name, str) and name.strip():
                return name.strip()[:80]

        # Gemini unavailable or unsure -- accept a reply that simply looks like a name.
        if len(stripped) <= 60 and _NAME_SHAPE_RE.match(stripped):
            return stripped

        # Last resort: the profile may already carry it.
        if state.profile is not None and state.profile.name:
            return state.profile.name
        return None

    # -- stage: the question / answer loop --------------------------------

    async def _interview_turn(
        self, state: InterviewSessionState, sid: str, message: str
    ) -> AsyncIterator[Any]:
        # The candidate asking to stop wins over everything else.
        if wants_to_end(message):
            state.record_answer(message)
            async for chunk in self._finish(state, sid, "the candidate asked to end the interview"):
                yield chunk
            return

        state.record_answer(message)

        # Hard 10-minute budget, checked on every turn.
        if state.is_time_up():
            async for chunk in self._finish(state, sid, "the interview reached its time limit"):
                yield chunk
            return

        chunk = await self._ask_next_question(state, sid, is_first=False)
        if chunk is None:
            async for ending in self._finish(state, sid, "the interview covered its ground"):
                yield ending
            return
        yield chunk

    async def _ask_next_question(
        self, state: InterviewSessionState, sid: str, *, is_first: bool
    ) -> Optional[InterviewChunk]:
        """Generate and register the next question.

        Returns ``None`` when the interview should end instead.
        """
        min_questions = max(1, settings.INTERVIEW_MIN_QUESTIONS)
        max_questions = max(min_questions, settings.INTERVIEW_MAX_QUESTIONS)
        questions_asked = len(state.qa)

        # Deterministic upper bound shared by profile- and job-based flows.
        # Once the fifth answer is recorded, finish without asking question 6.
        if questions_asked >= max_questions:
            return None

        data = await call_gemini_json(
            SYSTEM_PROMPT_QUESTION,
            build_question_user_turn(
                candidate_name=state.candidate_name or "the candidate",
                source=(state.source or InterviewSource.PROFILE).value,
                job=state.job.model_dump() if state.job else None,
                profile=state.profile.model_dump() if state.profile else None,
                extra_conditions=state.extra_conditions,
                transcript=state.transcript(),
                questions_asked=questions_asked,
                min_questions=min_questions,
                max_questions=max_questions,
                seconds_remaining=state.seconds_remaining(),
                is_first=is_first,
            ),
            temperature=0.7,
            max_output_tokens=512,
        )

        if data is None:
            log.warning("question generation failed -- using the fallback question")
            question_text = _FALLBACK_FIRST_QUESTION if is_first else _FALLBACK_QUESTION
            topic, is_follow_up = "General", False
        else:
            # Gemini may decide coverage is sufficient, but only inside the
            # configured 4-5 question window; it cannot end after question 1-3.
            if bool(data.get("should_end")) and questions_asked >= min_questions and not is_first:
                return None
            question_text = str(data.get("question") or "").strip()
            if not question_text:
                question_text = _FALLBACK_FIRST_QUESTION if is_first else _FALLBACK_QUESTION
            topic = str(data.get("topic") or "General").strip() or "General"
            is_follow_up = bool(data.get("is_follow_up")) and not is_first

        state.pending_question = QAPair(
            question=question_text, topic=topic, is_follow_up=is_follow_up
        )

        return InterviewChunk.question_chunk(
            response=question_text,
            question_number=questions_asked + 1,
            topic=topic,
            is_follow_up=is_follow_up,
            seconds_remaining=state.seconds_remaining(),
            session_id=sid,
        )

    # -- ending -----------------------------------------------------------

    async def _finish(
        self, state: InterviewSessionState, sid: str, reason: str
    ) -> AsyncIterator[Any]:
        """Close the interview and emit the scored report."""
        state.stage = InterviewStage.ENDED
        state.ended_reason = reason
        state.pending_question = None

        report = await generate_report(state, reason)
        state.report = report

        closing = (
            f"That's the interview done -- thanks, {report.candidate_name}. "
            f"Here's how it went.\n\n"
        )

        log.info(
            "interview finished for session %s: %s (%s question(s), %.1f min, score %.1f)",
            sid, reason, report.questions_asked, report.duration_minutes, report.overall_score,
        )

        yield InterviewChunk.end_chunk(
            response=closing + format_report_markdown(report),
            report=report,
            reason=reason,
            session_id=sid,
        )
