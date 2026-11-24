"""Picks an agent for a query and streams its response back to the Node
connection that asked for it (targeted by ``sid``).

Routing is deterministic and role-aware (``app/agents/roles.py``): every agent
declares ``ROUTING_RULES``; the router scores them, restricted to the modes the
caller's role may use. When nothing matches, the scores tie, or a forbidden
agent clearly owns the request, the **copilot** answers (there is no
``mode:none`` dead end any more).

Invariant: every accepted query gets exactly ONE payload with ``isEnd: true``,
it is the last one, and nothing follows it -- whatever raises. The only
exception is a task cancelled because Node disconnected (nothing is emitted).
``ChunkEmitter`` enforces it; ``handle()`` guards the whole turn.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

import socketio

from app.agents import REGISTRY
from app.agents.base import AgentChunk
from app.agents.confirm import classify_reply
from app.agents.copilot import session as copilot_session
from app.agents.modes import AgentMode
from app.agents.roles import allowed_modes, is_mode_allowed, resolve_role
from app.agents.routing import is_self_narration
from app.agents.jobscrapper.formatter import format_job_for_data, format_jobs_markdown
from app.agents.jobscrapper.job_fetched_header_message import JOB_FETCHED_HEADER_MESSAGE
from app.agents.jobscrapper.models.job import Job
from app.agents.job_eligibility.job_eligiblity_header_message import JOB_ELIGIBILITY_HEADER_MESSAGE
from app.agents.resume_generator.schemas import RESUME_HEADER_MESSAGE
from app.agents.pr_outreach.schemas import PROutreachChunk
from app.agents.alumni_connect.schemas import AlumniConnectChunk
from app.agents.gap_analysis.schemas import GapAnalysisChunk
from app.agents.learning_recommendation.schemas import LearningRecommendationChunk
from app.agents.copilot.schemas import CopilotChunk, GENERIC_ERROR
from app.schemas import QueryRequest

JOB_CREATION_HEADER_MESSAGE = "mode:jobCreation:data"  # fallback; chunks carry their own header
OWNING_AGENT_ERROR = "Something went wrong while handling that. Please try again."
MISSING_END_TEXT = "I couldn't produce a response. Please try again."

log = logging.getLogger("orchestrator")

MODE_SWITCH_HEADERS: Dict[AgentMode, str] = {
    AgentMode.JOBS: "mode:switch:jobs",
    AgentMode.RESUME: "mode:switch:resume",
    AgentMode.ELIGIBILITY: "mode:switch:job-eligibility",
    AgentMode.JOB_CREATION: "mode:switch:job-creation",
    AgentMode.INTERVIEW: "mode:switch:ai-interviewer",
    AgentMode.PR_OUTREACH: "mode:switch:pr-outreach",
    AgentMode.ALUMNI_CONNECT: "mode:switch:alumni-connect",
    AgentMode.GAP_ANALYSIS: "mode:switch:gap-analysis",
    AgentMode.LEARNING_RECOMMENDATION: "mode:switch:learning-recommendation",
    AgentMode.COPILOT: "mode:switch:copilot",
}

# Header for content an agent streams as plain strings / job dicts (agents that
# yield AgentChunk objects carry their own headers).
CONTENT_HEADERS: Dict[AgentMode, str] = {
    AgentMode.JOBS: JOB_FETCHED_HEADER_MESSAGE,
    AgentMode.RESUME: RESUME_HEADER_MESSAGE,
    AgentMode.ELIGIBILITY: JOB_ELIGIBILITY_HEADER_MESSAGE,
    AgentMode.JOB_CREATION: JOB_CREATION_HEADER_MESSAGE,
    AgentMode.INTERVIEW: "text:mode:interview",
    AgentMode.PR_OUTREACH: PROutreachChunk.HEADER_IN_PROGRESS,
    AgentMode.ALUMNI_CONNECT: AlumniConnectChunk.HEADER_IN_PROGRESS,
    AgentMode.GAP_ANALYSIS: GapAnalysisChunk.HEADER_IN_PROGRESS,
    AgentMode.LEARNING_RECOMMENDATION: LearningRecommendationChunk.HEADER,
    AgentMode.COPILOT: CopilotChunk.HEADER_ANSWER,
}


def switch_header(mode: AgentMode) -> str:
    return MODE_SWITCH_HEADERS.get(mode, f"mode:switch:{mode.value}")


def _extract_options(item: Any, header_message: str = "") -> Optional[List[str]]:
    """Extract list of string choices from an AgentChunk or payload dict."""
    opts = getattr(item, "options", None)
    if opts and isinstance(opts, list):
        extracted = [str(o) for o in opts if o]
        if extracted:
            return extracted

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

    hdr = str(getattr(item, "header_message", None) or header_message or "")
    if hdr == "button:options" or hdr.startswith("button:options"):
        return [
            "I want to give a mock interview for this job",
            "I want to give an interview based on my profile",
        ]
    return None


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------


def _mode_scores(text: str, allowed: Optional[frozenset] = None) -> List[Tuple[AgentMode, int, int]]:
    """Score *text* against every (allowed) agent's routing rules, best first (stable)."""
    scored: List[Tuple[AgentMode, int, int]] = []
    for mode in AgentMode:
        if allowed is not None and mode not in allowed:
            continue
        rules = getattr(REGISTRY.get(mode.value), "ROUTING_RULES", None)
        if rules is None:
            continue
        total, strong = rules.score(text or "")
        if total:
            scored.append((mode, total, strong))
    scored.sort(key=lambda item: item[1], reverse=True)
    return scored


def route_query(text: str, role: Optional[str] = None) -> Optional[AgentMode]:
    """Pick the agent for a fresh request. Deterministic -- no API call.

    None when nothing the role may use matches, when the two best allowed
    candidates tie, or when a forbidden agent clearly owns the request.
    ``role=None`` filters nothing.
    """
    all_scores = _mode_scores(text)
    ok = all_scores if role is None else _mode_scores(text, allowed_modes(role))
    if not ok:
        return None
    if len(ok) > 1 and ok[0][1] == ok[1][1]:
        log.info("ambiguous routing for %r: %s", (text or "")[:60], [(m.value, s) for m, s, _ in ok[:3]])
        return None
    if ok[0][2] == 0 and all_scores and not is_mode_allowed(all_scores[0][0], role) and all_scores[0][2] > 0:
        return None
    return ok[0][0]


def denied_mode_for(text: str, role: str) -> Optional[AgentMode]:
    """The forbidden mode that clearly owns *text* (strong hit, strictly best), else None."""
    all_scores = _mode_scores(text)
    if not all_scores:
        return None
    top_mode, top_total, top_strong = all_scores[0]
    if is_mode_allowed(top_mode, role) or top_strong < 1:
        return None
    if len(all_scores) > 1 and all_scores[1][1] >= top_total:
        return None
    return top_mode


def detect_switch(text: str, current_mode: AgentMode, role: Optional[str] = None) -> Optional[AgentMode]:
    """Does *text* ask to leave *current_mode* for another allowed agent? Needs a STRONG hit."""
    if is_self_narration(text or ""):
        return None
    for mode, _total, strong in _mode_scores(text or "", allowed_modes(role)):
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


@dataclass(frozen=True)
class RouteDecision:
    mode: AgentMode                          # never None
    emit_switch: bool                        # emit the mode:switch:* line before the agent runs
    left_mode: Optional[AgentMode] = None    # agent being left (its on_mode_exit hook runs)
    replacement_query: Optional[str] = None
    denied_mode: Optional[AgentMode] = None  # hint for the copilot
    reason: str = "routed"                   # copilot_pending | pending_switch | switch | sticky | routed | fallback


async def resolve_mode(req: QueryRequest, role: str) -> RouteDecision:
    """Decide which agent handles this turn (PYTHON.md §3.4)."""
    text = req.user_query or ""
    sticky = AgentMode.from_name(req.mode_name) if req.mode_name else None

    # 0. A pending copilot confirmation answered with a plain yes/no.
    if (
        sticky in (None, AgentMode.COPILOT)
        and copilot_session.store.has_pending(req.sessionId)
        and classify_reply(text) is not None
    ):
        return RouteDecision(AgentMode.COPILOT, False, reason="copilot_pending")

    # 1. The UI's active mode, re-evaluated every turn.
    if sticky is not None and is_mode_allowed(sticky, role):
        confirmed = await _agent_pending_switch(sticky, req)
        if confirmed is not None:
            target, original_query = confirmed
            if target is not None and target != sticky and is_mode_allowed(target, role):
                return RouteDecision(
                    target, True, left_mode=sticky, replacement_query=original_query, reason="pending_switch"
                )
        target = detect_switch(text, sticky, role)
        if target is not None:
            decision = await _agent_release_decision(sticky, req, target)
            if decision == "release":
                return RouteDecision(target, True, left_mode=sticky, reason="switch")
            log.info("[%s] %s kept the session (%s) instead of switching to %s",
                     req.requestId, sticky.value, decision, target.value)
        return RouteDecision(
            sticky, False, reason="sticky",
            denied_mode=denied_mode_for(text, role) if sticky is AgentMode.COPILOT else None,
        )

    # 2. Fresh routing (no mode, unknown mode, or a mode this role may not use).
    best = route_query(text, role)
    if best is None:
        return RouteDecision(AgentMode.COPILOT, False, denied_mode=denied_mode_for(text, role), reason="fallback")
    return RouteDecision(best, True, reason="routed")


async def _agent_pending_switch(
    current_mode: AgentMode, req: QueryRequest
) -> Optional[tuple[Optional[AgentMode], str]]:
    """Let the active agent complete a switch it already asked the user about."""
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
    try:
        target_name, original_query = result
    except (TypeError, ValueError):
        return None
    return AgentMode.from_name(target_name), (original_query or req.user_query)


async def _agent_release_decision(current_mode: AgentMode, req: QueryRequest, target_mode: AgentMode) -> str:
    """Ask the active agent whether it releases the session: release | hold | ask.

    Missing hook or any exception means release (a broken hook must never trap
    the user). A bool is honoured as release/hold.
    """
    agent = REGISTRY.get(current_mode.value)
    hook = getattr(agent, "should_release", None)
    if hook is None:
        return "release"
    try:
        try:
            decision = await hook(req, target_mode.value)
        except TypeError:
            decision = await hook(req)  # hook that takes no target
    except Exception:
        log.exception("[%s] should_release failed for %s -- allowing the switch", req.requestId, current_mode.value)
        return "release"
    if isinstance(decision, bool):
        return "release" if decision else "hold"
    return decision if decision in ("release", "hold", "ask") else "release"


def _agent_error_chunk(agent: Any, message: str, session_id: str) -> Optional[AgentChunk]:
    factory = getattr(agent, "error_chunk", None)
    if factory is None:
        return None
    try:
        return factory(message, session_id)
    except Exception:
        log.exception("error_chunk failed for %s", getattr(agent, "name", "?"))
        return None


async def _terminate_mode(left_mode: AgentMode, req: QueryRequest) -> Optional[str]:
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


# ---------------------------------------------------------------------------
# Emission
# ---------------------------------------------------------------------------


class ChunkEmitter:
    """Single exit to the socket; guarantees one terminal chunk, last."""

    def __init__(self, sio: Any, sid: str, request_id: str, session_id: str) -> None:
        self.sio = sio
        self.sid = sid
        self.request_id = request_id
        self.session_id = session_id
        self.ended = False
        self.last_payload: Optional[dict] = None

    async def emit(self, payload: dict) -> None:
        if self.ended:
            log.warning("[%s] dropping a chunk emitted after isEnd (%s)", self.request_id, payload.get("header_message"))
            return
        payload["requestId"] = self.request_id
        await self.sio.emit("response", payload, to=self.sid)
        self.last_payload = payload
        self.ended = bool(payload.get("isEnd"))

    async def terminal_error(self, message: str = GENERIC_ERROR) -> None:
        if self.ended:
            return
        await self.emit({
            "requestId": self.request_id,
            "sessionId": self.session_id,
            "header_message": CopilotChunk.HEADER_ERROR,
            "response": message,
            "data": {
                "type": "copilot", "phase": "error", "message": message,
                "tool_calls": [], "ui_actions": [], "source": "system",
            },
            "isEnd": True,
        })

    async def finalize_missing_end(self) -> None:
        if self.ended:
            return
        if self.last_payload is None:
            await self.terminal_error(MISSING_END_TEXT)
            return
        final = dict(self.last_payload)
        final["isEnd"] = True
        await self.emit(final)


async def handle(req: QueryRequest, sio: socketio.AsyncServer, sid: str) -> None:
    """Run one query to completion; exactly one terminal chunk unless cancelled."""
    out = ChunkEmitter(sio, sid, req.requestId, req.sessionId)
    try:
        await _run(req, out)
    except asyncio.CancelledError:
        raise  # Node disconnected: emit nothing
    except Exception:
        log.exception("[%s] orchestrator failure", req.requestId)
        await out.terminal_error()
    else:
        if not out.ended:
            await out.finalize_missing_end()


async def _run(req: QueryRequest, out: ChunkEmitter) -> None:
    role = resolve_role(req)
    decision = await resolve_mode(req, role)
    mode = decision.mode

    # A switch confirmed a turn late: the new agent gets the request the user
    # actually made, not the "yes" that approved it.
    if decision.replacement_query and decision.replacement_query != req.user_query:
        req = req.model_copy(update={"user_query": decision.replacement_query})

    agent = REGISTRY.get(mode.value)
    if agent is None:
        log.error("[%s] no agent registered for %s -- using the copilot", req.requestId, mode.value)
        mode = AgentMode.COPILOT
        agent = REGISTRY[mode.value]

    if mode is not AgentMode.COPILOT:
        copilot_session.store.clear(req.sessionId)  # confirmations live for one turn

    exit_notice: Optional[str] = None
    if decision.left_mode is not None:
        exit_notice = await _terminate_mode(decision.left_mode, req)
        log.info("[%s] leaving %s -> %s (%s)", req.requestId, decision.left_mode.value, mode.value, decision.reason)

    if decision.emit_switch:
        text = switch_message(mode)
        if exit_notice:
            text = f"{exit_notice} {text}"
        await out.emit({
            "sessionId": req.sessionId,
            "header_message": switch_header(mode),
            "response": text,
            "data": [],
            "isEnd": False,
        })

    if decision.denied_mode is not None:
        meta = dict(req.meta_data or {})
        meta["routing"] = {"denied_mode": decision.denied_mode.value, "role": role}
        req = req.model_copy(update={"meta_data": meta})

    log.info("[%s] routed to %s (role=%s, reason=%s)", req.requestId, mode.value, role, decision.reason)
    await _run_agent(agent, mode, req, role, out)


async def _run_agent(agent: Any, mode: AgentMode, req: QueryRequest, role: str, out: ChunkEmitter) -> None:
    header_message = CONTENT_HEADERS.get(mode, JOB_FETCHED_HEADER_MESSAGE)
    # The caller's real role (student, teacher, tpo, admin, company, alumni) -- never collapsed.
    list_role = role

    scraped_jobs: List[Dict[str, Any]] = []
    eligibility_results: List[Dict[str, Any]] = []
    status_header_parts: List[str] = []
    text_markdown_buffer = ""
    owns_output = bool(getattr(agent, "emits_own_chunks", False))

    try:
        async for item in agent.run(req):
            if isinstance(item, AgentChunk):
                payload: Dict[str, Any] = {
                    "sessionId": req.sessionId,
                    "header_message": item.header_message,
                    "response": item.response,
                    "data": item.data,
                    "isEnd": item.is_end,
                }
                if getattr(item, "confidence_score", None) is not None:
                    payload["confidence_score"] = item.confidence_score
                options = _extract_options(item, item.header_message)
                if options is not None:
                    payload["options"] = options
                await out.emit(payload)
                if not out.ended:
                    await asyncio.sleep(0.01)
                continue

            if isinstance(item, Job):
                scraped_jobs.append(format_job_for_data(item.model_dump(), role=list_role))
                await out.emit({
                    "header_message": header_message,
                    "response": format_jobs_markdown(scraped_jobs, role=list_role, status_header="".join(status_header_parts)),
                    "data": list(scraped_jobs),
                    "isEnd": False,
                })
            elif isinstance(item, dict) and item.get("type") == "eligibility_result":
                eligibility_results.append(item)
                await out.emit({
                    "header_message": header_message,
                    "response": "".join(status_header_parts) + text_markdown_buffer,
                    "data": list(eligibility_results),
                    "isEnd": False,
                })
            elif isinstance(item, dict) and (item.get("type") == "job_details" or "header_message" in item):
                header_message = item.get("header_message", "mode:jobparser:jobdetails")
                text_markdown_buffer += item.get("content") or item.get("text") or ""
                await out.emit({
                    "header_message": header_message,
                    "response": text_markdown_buffer,
                    "data": item.get("data", list(scraped_jobs)),
                    "isEnd": False,
                })
            elif isinstance(item, dict) and ("title" in item or "job" in item or "company" in item):
                raw_dict = item.get("job", item)
                scraped_jobs.append(format_job_for_data(raw_dict, role=list_role))
                await out.emit({
                    "header_message": header_message,
                    "response": format_jobs_markdown(scraped_jobs, role=list_role, status_header="".join(status_header_parts)),
                    "data": list(scraped_jobs),
                    "isEnd": False,
                })
            elif isinstance(item, str):
                if not scraped_jobs:
                    status_header_parts.append(item)
                    response_md = "".join(status_header_parts)
                else:
                    text_markdown_buffer += item
                    response_md = format_jobs_markdown(scraped_jobs, role=list_role, status_header="".join(status_header_parts))
                await out.emit({
                    "header_message": header_message,
                    "response": response_md,
                    "data": list(scraped_jobs),
                    "isEnd": False,
                })
            else:
                continue
            await asyncio.sleep(0.01)
    except asyncio.CancelledError:
        raise
    except Exception:
        log.exception("[%s] agent %s failed", req.requestId, getattr(agent, "name", mode.value))
        if out.ended:
            return
        if owns_output:
            chunk = _agent_error_chunk(agent, OWNING_AGENT_ERROR, req.sessionId)
            await out.emit({
                "sessionId": req.sessionId,
                "header_message": chunk.header_message if chunk else header_message,
                "response": chunk.response if chunk else OWNING_AGENT_ERROR,
                "data": chunk.data if chunk else {"type": "error"},
                "isEnd": True,
            })
        else:
            fallback_md = (
                format_jobs_markdown(scraped_jobs, role=list_role, status_header="".join(status_header_parts))
                if scraped_jobs else ("".join(status_header_parts) + text_markdown_buffer) or OWNING_AGENT_ERROR
            )
            await out.emit({
                "header_message": header_message,
                "response": fallback_md,
                "data": list(scraped_jobs),
                "isEnd": True,
            })
        return

    if owns_output:
        log.info("[%s] %s done", req.requestId, getattr(agent, "name", mode.value))
        return

    if scraped_jobs:
        final_md = format_jobs_markdown(scraped_jobs, role=list_role, status_header="".join(status_header_parts))
    else:
        final_md = "".join(status_header_parts) + text_markdown_buffer
    await out.emit({
        "header_message": header_message,
        "response": final_md,
        "data": list(scraped_jobs) if scraped_jobs else list(eligibility_results),
        "isEnd": True,
    })
    log.info("[%s] done (%d jobs, role=%s)", req.requestId, len(scraped_jobs), role)
