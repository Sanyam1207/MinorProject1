"""Picks an agent for a query and streams its response straight back to the
Node connection that asked for it (targeted by `sid`, that connection's own
socket.io session id).

Reads `user_role` directly from `req.user_role` ('tpo' or 'student'), defaulting to 'student'
if missing or invalid, formats human-readable Markdown response preambles for the left side of the UI,
and formats structured job objects for the right side UI `data` containing strictly:
- title
- company_name
- job_type
- salary
- experience
- job_domain
- application_url
- isEligible (included ONLY when user is a student)
"""

import asyncio
import logging
from typing import List, Dict, Any, Optional, Tuple

import socketio

from app.agents import REGISTRY
from app.agents.modes import AgentMode
from app.agents.jobscrapper.job_fetched_header_message import JOB_FETCHED_HEADER_MESSAGE
from app.agents.job_eligibility.job_eligiblity_header_message import JOB_ELIGIBILITY_HEADER_MESSAGE
from app.agents.jobscrapper.models.job import Job
from app.agents.base import AgentChunk
from app.agents.routing import is_self_narration
from app.agents.resume_generator.schemas import RESUME_HEADER_MESSAGE
from app.agents.resume_generator.schemas import ResumeChunk
from app.agents.job_creator.schemas import JobCreationChunk
from app.agents.pr_outreach.schemas import PROutreachChunk
from app.agents.alumni_connect.schemas import AlumniConnectChunk
from app.agents.gap_analysis.schemas import GapAnalysisChunk
from app.agents.learning_recommendation.schemas import LearningRecommendationChunk
from app.schemas import QueryRequest, PastMessage

from app.agents.jobscrapper.formatter import format_job_for_data, format_jobs_markdown

JOB_CREATION_HEADER_MESSAGE = "mode:jobCreation:data"  # fallback; chunks carry their own header

log = logging.getLogger("orchestrator")

MODE_SWITCH_HEADERS = {
    AgentMode.JOBS: "mode:switch:jobs",
    AgentMode.RESUME: "mode:switch:resume",
    AgentMode.ELIGIBILITY: "mode:switch:job-eligibility",
    AgentMode.JOB_CREATION: "mode:switch:job-creation",
    AgentMode.INTERVIEW: "mode:switch:ai-interviewer",
    AgentMode.PR_OUTREACH: "mode:switch:pr-outreach",
    AgentMode.ALUMNI_CONNECT: "mode:switch:alumni-connect",
    AgentMode.GAP_ANALYSIS: "mode:switch:gap-analysis",
    AgentMode.LEARNING_RECOMMENDATION: "mode:switch:learning-recommendation",
}

# Header sent on the content chunks an agent actually streams back, once a
# mode is active -- distinct from MODE_SWITCH_HEADERS, which only covers the
# one-off "you're now in X mode" confirmation. Falls back to the jobs header
# for any mode that doesn't have its own (kept as prior behaviour).
CONTENT_HEADERS = {
    AgentMode.JOBS: JOB_FETCHED_HEADER_MESSAGE,
    AgentMode.RESUME: RESUME_HEADER_MESSAGE,
    AgentMode.ELIGIBILITY: JOB_ELIGIBILITY_HEADER_MESSAGE,
    AgentMode.JOB_CREATION: JOB_CREATION_HEADER_MESSAGE,
    AgentMode.PR_OUTREACH: PROutreachChunk.HEADER_IN_PROGRESS,
    AgentMode.ALUMNI_CONNECT: AlumniConnectChunk.HEADER_IN_PROGRESS,
    AgentMode.GAP_ANALYSIS: GapAnalysisChunk.HEADER_IN_PROGRESS,
    AgentMode.LEARNING_RECOMMENDATION: LearningRecommendationChunk.HEADER,
}


def _extract_options(item: Any, header_message: str = "") -> Optional[List[str]]:
    """Extract list of string choices from an AgentChunk or payload dict."""
    # 1. Direct options attribute on chunk object
    opts = getattr(item, "options", None)
    if opts and isinstance(opts, list):
        extracted = [str(o) for o in opts if o]
        if extracted:
            return extracted

    # 2. Extract from item.data dict if present
    data = getattr(item, "data", None) if not isinstance(item, dict) else item.get("data")
    if isinstance(data, dict) and "options" in data:
        raw_opts = data["options"]
        if isinstance(raw_opts, list):
            extracted = []
            for opt in raw_opts:
                if isinstance(opt, str):
                    extracted.append(opt)
                elif isinstance(opt, dict):
                    label = opt.get("label") or opt.get("value") or opt.get("title") or opt.get("name")
                    if label:
                        extracted.append(str(label))
            if extracted:
                return extracted

    # 3. Direct options key on item dict
    if isinstance(item, dict) and "options" in item and isinstance(item["options"], list):
        extracted = []
        for opt in item["options"]:
            if isinstance(opt, str):
                extracted.append(opt)
            elif isinstance(opt, dict):
                label = opt.get("label") or opt.get("value") or opt.get("title") or opt.get("name")
                if label:
                    extracted.append(str(label))
        if extracted:
            return extracted

    # 4. Fallback when header is button:options
    hdr = str(getattr(item, "header_message", None) or header_message or "")
    if hdr == "button:options" or hdr.startswith("button:options"):
        return [
            "I want to give a mock interview for this job",
            "I want to give an interview based on my profile",
        ]

    return None

def _mode_scores(text: str) -> List[Tuple[AgentMode, int, int]]:
    """Score *text* against every agent's own routing rules, best first."""
    scored: List[Tuple[AgentMode, int, int]] = []
    for mode in AgentMode:
        rules = getattr(REGISTRY.get(mode.value), "ROUTING_RULES", None)
        if rules is None:
            continue
        total, strong = rules.score(text)
        if total:
            scored.append((mode, total, strong))
    scored.sort(key=lambda item: item[1], reverse=True)
    return scored


def route_query(text: str) -> Optional[AgentMode]:
    """Pick the agent for a fresh request. Deterministic -- no API call.

    Returns None when nothing matches, or when the two best candidates tie and
    there is no honest way to choose between them.
    """
    scored = _mode_scores(text or "")
    if not scored:
        return None
    if len(scored) > 1 and scored[0][1] == scored[1][1]:
        log.info("ambiguous routing for %r: %s", (text or "")[:60],
                 [(m.value, s) for m, s, _ in scored[:3]])
        return None
    return scored[0][0]


def detect_switch(text: str, current_mode: AgentMode) -> Optional[AgentMode]:
    """Decide whether *text* asks to leave *current_mode* for another agent.

    Deliberately stricter than `route_query`: leaving an active workflow needs
    a STRONG match on the other agent's rules. A weak topic hit is not enough,
    which is what stops an interview answer like "I built a job board" -- one
    weak "job" -- from tearing down the interview.
    """
    # Someone describing their own work is answering, not instructing.
    if is_self_narration(text or ""):
        return None
    for mode, _total, strong in _mode_scores(text or ""):
        if mode == current_mode:
            continue
        if strong:
            return mode
        break
    return None


def switch_message(mode: AgentMode) -> str:
    """The one-line confirmation shown when the user is moved to *mode*."""
    agent = REGISTRY.get(mode.value)
    return getattr(agent, "SWITCH_MESSAGE", None) or f"Switching you to {mode.value}."


async def resolve_mode(
    req: QueryRequest,
) -> tuple[Optional[AgentMode], bool, Optional[AgentMode], Optional[str]]:
    """Decide which agent handles this turn.

    Returns ``(mode, is_explicit, left_mode, replacement_query)``:

    * ``mode``        -- the agent to run, or None if nothing matched.
    * ``is_explicit`` -- True when the UI's own mode is being continued, so no
                         "switching you to X" line is emitted.
    * ``left_mode``   -- set only when the user is being moved OUT of an active
                         mode, so the caller can terminate that agent's session
                         before the new one runs.
    * ``replacement_query`` -- set when the switch is being completed a turn
                         late (the user was asked to confirm), so the receiving
                         agent gets the request they actually made instead of
                         the word "yes".

    A UI-provided ``mode_name`` keeps the workflow locked for follow-up turns,
    but is re-evaluated every turn: a user mid-interview who asks for something
    another agent owns is released to that agent rather than being trapped.
    """
    if req.mode_name is not None:
        current_mode = AgentMode.from_name(req.mode_name)
        if current_mode is None:
            return None, True, None, None

        # The active agent may have asked the user to confirm a switch last
        # turn and now be acting on their answer.
        confirmed = await _agent_pending_switch(current_mode, req)
        if confirmed is not None:
            target_mode, original_query = confirmed
            if target_mode is not None and target_mode != current_mode:
                return target_mode, False, current_mode, original_query

        target_mode = detect_switch(req.user_query, current_mode)
        if target_mode is not None:
            decision = await _agent_release_decision(current_mode, req, target_mode)
            if decision == "release":
                return target_mode, False, current_mode, None
            if decision == "ask":
                # The agent will put the question to the user on this turn; it
                # keeps the session so nothing is lost either way.
                log.info(
                    "[%s] %s is asking the user before switching to %s",
                    req.requestId, current_mode.value, target_mode.value,
                )
            else:
                log.info(
                    "[%s] %s declined to release the session for a switch to %s",
                    req.requestId, current_mode.value, target_mode.value,
                )
            return current_mode, True, None, None

        # "continue" and "none" both stay put: inside an active workflow almost
        # every message is a continuation, and the agent itself is better placed
        # to answer an off-topic one than a generic "I couldn't understand".
        return current_mode, True, None, None

    return route_query(req.user_query), False, None, None


async def _agent_pending_switch(
    current_mode: AgentMode, req: QueryRequest
) -> Optional[tuple[Optional[AgentMode], str]]:
    """Let the active agent complete a switch it already asked the user about.

    Agents opt in with ``async def pending_switch(self, req)`` returning
    ``(target_mode_name, original_query)`` once the user has confirmed, or None.
    Checked before the router so a plain "yes" is not re-classified from scratch.
    """
    agent = REGISTRY.get(current_mode.value)
    hook = getattr(agent, "pending_switch", None)
    if hook is None:
        return None
    try:
        result = await hook(req)
    except Exception:
        log.exception("[%s] pending_switch failed for %s", req.requestId, current_mode.value)
        return None
    if not result:
        return None
    target_name, original_query = result
    return AgentMode.from_name(target_name), (original_query or req.user_query)


async def _agent_release_decision(
    current_mode: AgentMode, req: QueryRequest, target_mode: AgentMode
) -> str:
    """Ask the active agent what to do about losing its session to a switch.

    The router's switch verdict comes from an LLM, so it can misread a message
    that merely mentions another agent's subject matter. An agent mid-workflow
    knows better than the router whether this turn is really an exit, so it may
    define ``async def should_release(self, req, target) -> str`` returning:

    ``"release"`` switch now, ``"hold"`` stay put silently, or ``"ask"`` stay
    put for one turn and put the question to the user.

    Agents without the hook always release. A hook returning a bool is honoured
    as release/hold.
    """
    agent = REGISTRY.get(current_mode.value)
    hook = getattr(agent, "should_release", None)
    if hook is None:
        return "release"
    try:
        decision = await hook(req, target_mode.value)
    except TypeError:
        decision = await hook(req)  # hook that takes no target
    except Exception:
        log.exception(
            "[%s] should_release failed for %s -- allowing the switch",
            req.requestId, current_mode.value,
        )
        return "release"

    if isinstance(decision, bool):
        return "release" if decision else "hold"
    return decision if decision in ("release", "hold", "ask") else "release"


def _agent_error_chunk(agent: Any, message: str, session_id: str) -> Optional[AgentChunk]:
    """Ask a chunk-owning agent for its own terminal error chunk.

    Each agent knows the ``data`` shape its frontend panel expects on failure,
    so the orchestrator asks rather than hardcoding one per agent. Falls back
    to None if the agent has no factory or it raises.
    """
    factory = getattr(agent, "error_chunk", None)
    if factory is None:
        return None
    try:
        return factory(message, session_id)
    except Exception:
        log.exception("error_chunk failed for %s", getattr(agent, "name", "?"))
        return None


async def _terminate_mode(left_mode: AgentMode, req: QueryRequest) -> Optional[str]:
    """Tell the agent being left that it is losing control of this session.

    Agents opt in by defining ``async def on_mode_exit(self, req)``. It may
    return a short notice ("I've ended your interview") that is prepended to the
    mode-switch line; agents without the hook are simply left alone.
    """
    agent = REGISTRY.get(left_mode.value)
    hook = getattr(agent, "on_mode_exit", None)
    if hook is None:
        return None
    try:
        notice = await hook(req)
    except Exception:
        log.exception("[%s] on_mode_exit failed for %s", req.requestId, left_mode.value)
        return None
    return notice.strip() if isinstance(notice, str) and notice.strip() else None


async def handle(req: QueryRequest, sio: socketio.AsyncServer, sid: str) -> None:
    """Run the chosen agent and stream `response` events back to `sid` in real-time."""
    mode, is_explicit, left_mode, replacement_query = await resolve_mode(req)

    # A switch confirmed a turn late: run the new agent against the request the
    # user actually made, not the "yes" that approved it.
    if replacement_query and replacement_query != req.user_query:
        req = req.model_copy(update={"user_query": replacement_query})

    if mode is None or mode.value not in REGISTRY:
        log.warning(
            "[%s] no agent matched (mode=%r) for query: %r",
            req.requestId, mode, req.user_query,
        )
        await sio.emit(
            "response",
            {
                "requestId": req.requestId,
                "header_message": "mode:none",
                "response": (
                    "I couldn't figure out what you're asking for. Try something like "
                    "\"find me software jobs in Bangalore\" or \"help me build my resume\"."
                ),
                "data": [],
                "isEnd": True,
            },
            to=sid,
        )
        return

    # Being moved out of an active mode: stop that agent before the new one
    # starts, so a half-finished workflow isn't left running behind the user.
    exit_notice: Optional[str] = None
    if left_mode is not None:
        exit_notice = await _terminate_mode(left_mode, req)
        log.info(
            "[%s] leaving %s -> %s (rerouted)", req.requestId, left_mode.value, mode.value
        )

    if not is_explicit:
        response_text = switch_message(mode)
        if exit_notice:
            response_text = f"{exit_notice} {response_text}"
        await sio.emit(
            "response",
            {
                "requestId": req.requestId,
                "header_message": MODE_SWITCH_HEADERS[mode],
                "response": response_text,
                "data": [],
                "isEnd": False,
            },
            to=sid,
        )

    agent = REGISTRY[mode.value]
    header_message = CONTENT_HEADERS.get(mode, JOB_FETCHED_HEADER_MESSAGE)

    # Extract user_role directly from QueryRequest ('tpo' or 'student'), defaulting to 'student' if missing/invalid
    raw_role = getattr(req, "user_role", None) or ""
    role = raw_role.strip().lower()
    if role != "tpo":
        role = "student"

    log.info("[%s] routed to %s (user_role: %s -> evaluated role: %s)", req.requestId, agent.name, req.user_role, role)

    scraped_jobs: List[Dict[str, Any]] = []
    eligibility_results: List[Dict[str, Any]] = []
    status_header_parts: List[str] = []
    text_markdown_buffer: str = ""
    # Agents that yield AgentChunk objects own their own wire format: the
    # orchestrator emits what they give it and adds no final chunk of its own.
    owns_output: bool = bool(getattr(agent, "emits_own_chunks", False))
    is_resume_agent: bool = (mode == AgentMode.RESUME)
    is_job_creation_agent: bool = (mode == AgentMode.JOB_CREATION)
    is_pr_outreach_agent: bool = (mode == AgentMode.PR_OUTREACH)

    try:
        async for item in agent.run(req):
            # ------------------------------------------------------------------
            # Agent-owned chunk: emitted verbatim. The chunk carries its own
            # header and data payload, so none of the job-accumulation logic
            # below applies to it.
            # ------------------------------------------------------------------
            if isinstance(item, AgentChunk):
                payload = {
                    "requestId": req.requestId,
                    "sessionId": req.sessionId,
                    "header_message": item.header_message,
                    "response": item.response,
                    "data": item.data,
                    "isEnd": item.is_end,
                }
                if getattr(item, "confidence_score", None) is not None:
                    payload["confidence_score"] = item.confidence_score
                extracted_options = _extract_options(item, item.header_message)
                if extracted_options is not None:
                    payload["options"] = extracted_options
                await sio.emit(
                    "response",
                    payload,
                    to=sid,
                )
                await asyncio.sleep(0.01)
                continue
            # ------------------------------------------------------------------
            # If item is a Job Pydantic model
            if isinstance(item, Job):
                job_dict = format_job_for_data(item.model_dump(), role=role)
                scraped_jobs.append(job_dict)
                response_md = format_jobs_markdown(scraped_jobs, role=role, status_header="".join(status_header_parts))

                await sio.emit(
                    "response",
                    {
                        "requestId": req.requestId,
                        "header_message": header_message,
                        "response": response_md,
                        "data": list(scraped_jobs),
                        "isEnd": False,
                    },
                    to=sid,
                )
                await asyncio.sleep(0.01)

            # If item is a structured eligibility verdict from JobEligibilityAgent
            # (checked before the generic job-dict branch below, since this
            # dict also carries a "job" key -- a job id, not a job listing --
            # which would otherwise mis-match that branch).
            elif isinstance(item, dict) and item.get("type") == "eligibility_result":
                eligibility_results.append(item)
                response_md = "".join(status_header_parts) + text_markdown_buffer

                await sio.emit(
                    "response",
                    {
                        "requestId": req.requestId,
                        "header_message": header_message,
                        "response": response_md,
                        "data": list(eligibility_results),
                        "isEnd": False,
                    },
                    to=sid,
                )
                await asyncio.sleep(0.01)

            elif isinstance(item, dict) and (item.get("type") == "job_details" or "header_message" in item):
                custom_header = item.get("header_message", "mode:jobparser:jobdetails")
                header_message = custom_header
                content = item.get("content") or item.get("text") or ""
                text_markdown_buffer += content

                await sio.emit(
                    "response",
                    {
                        "requestId": req.requestId,
                        "header_message": custom_header,
                        "response": text_markdown_buffer,
                        "data": item.get("data", list(scraped_jobs)),
                        "isEnd": False,
                    },
                    to=sid,
                )
                await asyncio.sleep(0.01)
           
            # If item is a dict containing job data
            elif isinstance(item, dict) and ("title" in item or "job" in item or "company" in item):
                raw_dict = item.get("job", item)
                job_dict = format_job_for_data(raw_dict, role=role)
                scraped_jobs.append(job_dict)
                response_md = format_jobs_markdown(scraped_jobs, role=role, status_header="".join(status_header_parts))

                await sio.emit(
                    "response",
                    {
                        "requestId": req.requestId,
                        "header_message": header_message,
                        "response": response_md,
                        "data": list(scraped_jobs),
                        "isEnd": False,
                    },
                    to=sid,
                )
                await asyncio.sleep(0.01)

            # If item is a text chunk or status string
            elif isinstance(item, str):
                if not scraped_jobs:
                    status_header_parts.append(item)
                    response_md = "".join(status_header_parts)
                else:
                    text_markdown_buffer += item
                    response_md = format_jobs_markdown(scraped_jobs, role=role, status_header="".join(status_header_parts))

                await sio.emit(
                    "response",
                    {
                        "requestId": req.requestId,
                        "header_message": header_message,
                        "response": response_md,
                        "data": list(scraped_jobs),
                        "isEnd": False,
                    },
                    to=sid,
                )
                await asyncio.sleep(0.01)

    except Exception as exc:
        log.exception("[%s] agent failed", req.requestId)
        if owns_output:
            chunk = _agent_error_chunk(agent, f"Something went wrong: {exc}", req.sessionId)
            await sio.emit(
                "response",
                {
                    "requestId": req.requestId,
                    "sessionId": req.sessionId,
                    "header_message": chunk.header_message if chunk else header_message,
                    "response": chunk.response if chunk else f"Something went wrong: {exc}",
                    "data": chunk.data if chunk else {"type": "error"},
                    "isEnd": True,
                },
                to=sid,
            )
        else:
            fallback_md = format_jobs_markdown(scraped_jobs, role=role, status_header="".join(status_header_parts)) if scraped_jobs else (text_markdown_buffer or str(exc))
            await sio.emit(
                "response",
                {
                    "requestId": req.requestId,
                    "header_message": JOB_FETCHED_HEADER_MESSAGE,
                    "response": fallback_md,
                    "data": list(scraped_jobs),
                    "isEnd": True,
                },
                to=sid,
            )
        return

    # Final emit when agent finishes
    # Resume and Job Creation agents handle their own final isEnd=True chunk.
    if owns_output:
        log.info("[%s] %s done", req.requestId, agent.name)
        return

    if is_pr_outreach_agent:
        log.info("[%s] pr-outreach agent done", req.requestId)
        return

    if scraped_jobs:
        final_md = format_jobs_markdown(scraped_jobs, role=role, status_header="".join(status_header_parts))
    else:
        final_md = "".join(status_header_parts) + text_markdown_buffer

    await sio.emit(
        "response",
        {
            "requestId": req.requestId,
            "header_message": header_message,
            "response": final_md,
            "data": list(scraped_jobs) if scraped_jobs else list(eligibility_results),
            "isEnd": True,
        },
        to=sid,
    )
    log.info("[%s] done (%d jobs, role=%s)", req.requestId, len(scraped_jobs), role)
