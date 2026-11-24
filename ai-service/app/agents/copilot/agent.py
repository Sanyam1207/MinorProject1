"""The copilot: a tool-calling campus assistant (AGENT-TOOLS.md §6, PYTHON.md §5).

Tools execute inside the Node backend AS the logged-in user (``meta_data``
carries the tool URL and a short-lived Bearer token). Each turn:

A. a pending confirmation is resolved first ("Confirm" re-executes the stored,
   server-normalised arguments with ``confirmed: true``; "Cancel" drops it;
   anything else drops it and is handled as a new request);
B. no tool access -> a fixed answer, no LLM call;
C/D. ``copilot:thinking``, then the role's tool manifest;
E. an awaited clarification is resumed deterministically;
F. Gemini function calling (up to ``COPILOT_MAX_TOOL_ROUNDS`` rounds);
G. otherwise -- no key, or the LLM failed before any tool ran -- the offline
   planner picks ONE tool.

Every tool result's ``ui`` becomes a ``ui_actions`` entry immediately, and
every request ends with exactly one terminal chunk (answer, confirm or error).
``confirmed`` is never taken from the LLM: it is only sent by
``_run_confirmed`` after the human pressed "Confirm".
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, AsyncIterator, Dict, List, Optional

from app.config import settings
from app.schemas import QueryRequest
from app.tools_client import has_tool_access
from app.agents.confirm import classify_reply
from app.agents.routing import RoutingRules, URL_PATTERN
from app.agents.copilot import planner
from app.agents.copilot import session as copilot_session
from app.agents.copilot import tools_client as copilot_tools
from app.agents.copilot.context import CopilotContext, build_context
from app.agents.copilot.llm import (
    CopilotLLMError,
    GeminiCopilotLLM,
    history_to_contents,
    manifest_to_function_declarations,
)
from app.agents.copilot.prompt import build_system_prompt
from app.agents.copilot.schemas import (
    BLOCKED_TEXT,
    CANCELLED_TEXT,
    CONFIRM_AGAIN_TEXT,
    EXPIRED_TEXT,
    FALLBACK_UNKNOWN,
    GENERIC_ERROR,
    NO_TOOLS_TEXT,
    UNREACHABLE_TEXT,
    CopilotChunk,
    TurnState,
    humanize,
)
from app.agents.copilot.session import AwaitingInput, PendingAction
from app.agents.copilot.tools_client import Manifest, ToolResult, ToolsUnavailable
from app.agents.jobscrapper.search import campus_item, market_item, merge_items
from app.agents.jobscrapper.session_store import session_job_store

log = logging.getLogger("copilot")

MAX_CALLS_PER_TURN = 12
_AWAIT_ARG_KEYS = ("session", "course", "job", "application", "offer", "program", "resume", "student")


def _clamp_rounds() -> int:
    try:
        rounds = int(settings.COPILOT_MAX_TOOL_ROUNDS)
    except (TypeError, ValueError):
        rounds = 6
    return max(1, min(10, rounds))


def _sanitize_args(args: Any) -> Dict[str, Any]:
    """LLM arguments: non-dict -> {}; ``confirmed`` is never LLM-controlled."""
    if not isinstance(args, dict):
        return {}
    return {str(key): value for key, value in args.items() if str(key).lower() != "confirmed"}


def generic_preview(tool: str, args: Dict[str, Any]) -> str:
    details = ", ".join(f"{key}={value}" for key, value in args.items())
    return f"{humanize(tool)} with {details}?" if details else f"{humanize(tool)}?"


def error_text(result: ToolResult) -> str:
    """The user-facing line for a tool result (PYTHON.md §5.7 error-text mapping)."""
    if result.ok:
        return result.summary or f"Done: {humanize(result.tool)}."
    code = result.error or "ERROR"
    if code == "AMBIGUOUS":
        lines = [result.message or "I found more than one match."]
        lines += [f"{index}. {candidate['label']}" for index, candidate in enumerate(result.candidates or [], 1)]
        lines.append("Reply with the number or name.")
        return "\n".join(lines)
    if code in ("FORBIDDEN", "UNKNOWN_TOOL"):
        return "That isn't available for your account."
    if code == "INTERNAL":
        return "The campus service couldn't do that. Please try again."
    return f"I couldn't do that: {result.message}" if result.message else "I couldn't do that."


def function_response_part(call: Any, result: ToolResult) -> dict:
    if result.ok:
        response: Dict[str, Any] = {"ok": True, "summary": result.summary}
        try:
            serialized = json.dumps(result.data, default=str, ensure_ascii=False)
        except (TypeError, ValueError):
            serialized = json.dumps(str(result.data), ensure_ascii=False)
        limit = max(200, int(settings.COPILOT_TOOL_RESULT_MAX_CHARS))
        if len(serialized) > limit:
            response["data_truncated"] = True
            response["data_preview"] = serialized[:limit]
        else:
            response["data"] = result.data
    else:
        response = {"ok": False, "error": result.error or "ERROR", "message": result.message}
        if result.candidates:
            response["candidates"] = result.candidates
    function_response: Dict[str, Any] = {"name": call.name, "response": response}
    if getattr(call, "id", None):
        function_response["id"] = call.id
    return {"functionResponse": function_response}


class CopilotAgent:
    name = "copilot"

    ROUTING_RULES = RoutingRules(
        strong=(
            r"\b(mark|take|record|start|open|begin|end|stop|close|show|check|view|see|get)\b[^.?!]{0,25}\battendance\b",
            r"\battendance\s+(report|summary|status|percentage|percent|records?|history|shortage|analytics)\b",
            r"\bmy\s+attendance\b",
            r"\bshort\s+(on|of)\s+attendance\b",
            r"\bdefaulters?\b",
            r"\b(schedule|reschedule|book|cancel|postpone|prepone|move|shift|plan|arrange|add|set\s+up|find)\b[^.?!]{0,30}\b(class|classes|lecture|lectures|lab|labs|tutorial|tutorials)\b",
            r"\b(my|today'?s|tomorrow'?s|this\s+week'?s|next\s+week'?s|upcoming)\s+(classes|lectures|schedule|timetable)\b",
            r"\bmy\s+next\s+(class|lecture)\b",
            r"\b(show|view|check)\b[^.?!]{0,10}\btime\s*-?\s*table\b",
            r"\b(class|attendance|qr)\s+session\b",
            r"\b(create|add|new|set\s+up)\b[^.?!]{0,20}\bcourse\b",
            r"\bjoin\s+code\b",
            r"\b(scan|scanner)\b[^.?!]{0,20}\b(qr|code|attendance)\b",
            r"\b(open|show|start)\b[^.?!]{0,10}\b(qr\s+)?scanner\b",
            r"\b(show|generate|display|open|start|create|project)\b[^.?!]{0,20}\bqr\b",
            r"\b(show|list|check|track|view)\b[^.?!]{0,20}\bapplications\b",
            r"\bmy\s+(job\s+)?applications\b",
            r"\b(job|drive)\s+applications?\b",
            r"\bapplication\s+status\b",
            r"\bstatus\s+of\s+my\s+applications?\b",
            r"\bapply\s+(to|for)\b",
            r"\b(cancel|withdraw)\b[^.?!]{0,30}\bapplication\b",
            r"\b(my|any|new|pending)\s+offers?\b",
            r"\b(accept|reject|decline)\b[^.?!]{0,30}\boffer\b",
            r"\boffer\s+letters?\b",
            r"\b(show|list|upcoming|available|my|any|register|enrol+)\b[^.?!]{0,15}\btraining\b",
            r"\btraining\s+(hub|calendar|schedule|programs?|programmes?)\b",
            r"\b(my|new|unread|any|show|check|read|clear)\s+(notifications?|alerts)\b",
            r"\bmark\b[^.?!]{0,20}\bnotifications?\b",
            r"\b(my|show|view)\s+profile\b",
            r"\b(list|show|view)\b[^.?!]{0,10}\bresumes\b",
            r"\bplacement\s+(stats|statistics|analytics|report|numbers)\b",
            r"\b(show|list|view|get|check)\b[^.?!]{0,20}\bapplicants\b",
            r"\bapplicants\s+(for|of|to)\b",
            r"\b(close|reopen|extend)\b[^.?!]{0,30}\bdrive\b",
            r"\b(show|list|view|my|active|open)\b[^.?!]{0,10}\bdrives\b",
            r"\bannounce(ment|ments)?\b",
            r"\b(invite|add)\b[^.?!]{0,20}\b(faculty|teachers?|professors?)\b",
            r"\bsync\b[^.?!]{0,20}\bjob\s*feed\b",
            r"\bwhat\s+can\s+you\s+do\b",
            r"\bhow\s+can\s+you\s+help\b",
        ),
        weak=(
            r"\battendance\b", r"\bclass(es)?\b", r"\blectures?\b", r"\bschedule\b", r"\btime\s*-?\s*table\b",
            r"\bcourses?\b", r"\bqr\b", r"\boffers?\b", r"\btraining\b", r"\bdrives?\b", r"\bnotifications?\b",
            r"\bapplicants?\b", r"\bfree\s+slot\b",
        ),
        veto=(
            r"\bmock\s+interview\b", r"\binterview\s+me\b", r"\bcan\s+i\s+apply\b", r"\b(am|are)\s+i\s+eligible\b",
            r"\b(build|create|generate|make|write|tailor)\b[^.?!]{0,20}\b(resume|cv)\b", URL_PATTERN,
        ),
    )
    SWITCH_MESSAGE = "Sure -- I'll take care of that."
    emits_own_chunks = True
    content_header = CopilotChunk.HEADER_ANSWER

    def __init__(self, *, tools_factory=None, llm=None, store=None) -> None:
        self._tools_factory = tools_factory
        self._llm = llm
        self._store = store

    # -- injectable collaborators (resolved at call time) ---------------------

    @property
    def tools_factory(self):
        return self._tools_factory or copilot_tools.make_copilot_tools

    @property
    def llm(self):
        if self._llm is None:
            self._llm = GeminiCopilotLLM()
        return self._llm

    @property
    def store(self) -> copilot_session.CopilotSessionStore:
        return self._store or copilot_session.store

    # -- orchestrator hooks ---------------------------------------------------

    @staticmethod
    def error_chunk(message: str, session_id: str = "") -> CopilotChunk:
        return CopilotChunk.error(message)

    async def should_release(self, req: QueryRequest, target: str = "") -> str:
        return "release"  # the fallback agent never traps the user

    async def on_mode_exit(self, req: QueryRequest) -> None:
        self.store.clear(req.sessionId)
        return None

    # -- turn -----------------------------------------------------------------

    async def run(self, req: QueryRequest) -> AsyncIterator[CopilotChunk]:
        turn = TurnState(request_id=req.requestId, source="llm")
        try:
            async for chunk in self._turn(req, turn):
                yield chunk
                if chunk.is_end:
                    return
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("[%s] copilot turn failed", req.requestId)
            yield CopilotChunk.error(GENERIC_ERROR, turn)

    async def _turn(self, req: QueryRequest, turn: TurnState) -> AsyncIterator[CopilotChunk]:
        ctx = build_context(req)
        sid = req.sessionId
        store = self.store
        text = ctx.user_query

        # A. pending confirmation
        pending, expired = store.peek_pending(sid)
        reply = classify_reply(text)
        if pending is not None:
            if expired:
                store.clear_pending(sid)
                if reply == "affirm":
                    turn.source = "system"
                    yield CopilotChunk.answer(turn, EXPIRED_TEXT)
                    return
                if reply == "negative":
                    turn.source = "system"
                    yield CopilotChunk.answer(turn, CANCELLED_TEXT)
                    return
            elif reply == "affirm":
                async for chunk in self._run_confirmed(req, ctx, turn, pending):
                    yield chunk
                return
            elif reply == "negative":
                store.clear_pending(sid)
                turn.source = "system"
                yield CopilotChunk.answer(turn, CANCELLED_TEXT)
                return
            else:
                store.clear_pending(sid)

        # B. no tool access
        if not has_tool_access(req.meta_data):
            log.warning("[%s] meta_data.tool_token missing — is AGENT_TOOL_SECRET set on the backend?", req.requestId)
            turn.source = "system"
            yield CopilotChunk.answer(turn, NO_TOOLS_TEXT)
            return

        # C/D. thinking + manifest
        llm = self.llm
        if not getattr(llm, "available", False):
            turn.source = "planner"
        yield CopilotChunk.thinking(turn)
        tools = self.tools_factory(req.meta_data or {}, request_id=req.requestId)
        try:
            manifest = await tools.manifest(ctx.role)
        except ToolsUnavailable as exc:
            log.warning("[%s] tool manifest unavailable (%s)", req.requestId, exc.code)
            yield CopilotChunk.error(UNREACHABLE_TEXT, turn)
            return

        # E. awaited clarification / choice
        awaiting = store.take_awaiting(sid)
        if awaiting is not None:
            outcome = planner.continue_awaiting(
                text, awaiting, manifest=manifest, session_id=sid,
                selected_job=ctx.selected_job, ui_context=ctx.ui_context,
            )
            if outcome is not None:
                turn.source = "planner"
                async for chunk in self._finish_planner(outcome, ctx, turn, tools, manifest):
                    yield chunk
                return

        # F. LLM function calling (an empty message has nothing to send)
        if getattr(llm, "available", False) and ctx.user_query:
            try:
                async for chunk in self._llm_turn(ctx, turn, tools, manifest, llm):
                    yield chunk
                return
            except CopilotLLMError as exc:
                log.warning("[%s] copilot LLM unavailable, using the planner: %s", req.requestId, exc)

        # G. offline planner
        async for chunk in self._planner_turn(ctx, turn, tools, manifest):
            yield chunk

    # -- confirmation ---------------------------------------------------------

    async def _run_confirmed(
        self, req: QueryRequest, ctx: CopilotContext, turn: TurnState, pending: PendingAction
    ) -> AsyncIterator[CopilotChunk]:
        turn.source = "confirm"
        self.store.clear_pending(ctx.session_id)
        tools = self.tools_factory(req.meta_data or {}, request_id=req.requestId)
        call = turn.start_call(pending.tool, pending.args)
        yield CopilotChunk.tool(turn)
        try:
            result = await tools.execute(pending.tool, dict(pending.args), confirmed=True)
        except ToolsUnavailable as exc:
            turn.fail_call(call, exc.code)
            yield CopilotChunk.error(UNREACHABLE_TEXT, turn)
            return
        if result.needs_confirmation:
            turn.fail_call(call, "NEEDS_CONFIRMATION", CONFIRM_AGAIN_TEXT)
            yield CopilotChunk.answer(turn, CONFIRM_AGAIN_TEXT)
            return
        turn.finish_call(call, result)
        self._remember_jobs(ctx, pending.tool, result)
        yield CopilotChunk.tool(turn)
        if result.ok:
            yield CopilotChunk.answer(turn, result.summary or f"Done: {humanize(pending.tool)}.")
        else:
            yield CopilotChunk.answer(turn, error_text(result), options=self._candidate_labels(result))

    # -- LLM path -------------------------------------------------------------

    async def _llm_turn(
        self, ctx: CopilotContext, turn: TurnState, tools: Any, manifest: Manifest, llm: Any
    ) -> AsyncIterator[CopilotChunk]:
        turn.source = "llm"
        rounds = _clamp_rounds()
        contents = history_to_contents(ctx.past_messages, ctx.user_query)
        declarations = manifest_to_function_declarations(manifest)
        system = build_system_prompt(ctx, manifest)
        executed = False
        calls_executed = 0
        cache: Dict[tuple, ToolResult] = {}
        names = manifest.names
        final: Optional[str] = None

        for round_no in range(1, rounds + 2):
            force_text = round_no > rounds or calls_executed >= MAX_CALLS_PER_TURN
            try:
                step = await llm.step(system=system, contents=contents, declarations=declarations, force_text=force_text)
            except CopilotLLMError:
                if not executed:
                    raise
                final = self._compose_answer(turn, ctx, manifest)
                break
            if step.blocked:
                final = BLOCKED_TEXT if not executed else self._compose_answer(turn, ctx, manifest)
                break
            if force_text or not step.calls:
                final = (step.text or "").strip() or self._compose_answer(turn, ctx, manifest)
                break

            model_content = step.model_content or {
                "role": "model",
                "parts": [{"functionCall": {"name": c.name, "args": c.args}} for c in step.calls],
            }
            contents.append(model_content)
            parts: List[dict] = []
            for fc in step.calls:
                args = _sanitize_args(fc.args)
                call = turn.start_call(fc.name, args)
                yield CopilotChunk.tool(turn)
                cached = False
                if fc.name not in names:
                    result = ToolResult.unknown(fc.name)
                else:
                    key = (fc.name, json.dumps(args, sort_keys=True, default=str))
                    if key in cache:
                        result = cache[key]
                        cached = True
                    else:
                        try:
                            result = await tools.execute(fc.name, args)
                        except ToolsUnavailable as exc:
                            turn.fail_call(call, exc.code)
                            yield CopilotChunk.error(UNREACHABLE_TEXT, turn)
                            return
                        cache[key] = result
                        executed = True
                        calls_executed += 1
                if result.needs_confirmation:
                    pending = PendingAction(
                        tool=result.tool or fc.name,
                        args=result.args if isinstance(result.args, dict) else args,
                        preview=result.preview or generic_preview(fc.name, args),
                        created_at=self.store.now(),
                        request_id=ctx.request_id,
                    )
                    self.store.set_pending(ctx.session_id, pending)
                    turn.mark_needs_confirmation(call, pending.preview)
                    yield CopilotChunk.confirm(turn, pending)
                    return
                # A reused result must not open the same panel twice.
                turn.finish_call(call, result, with_ui=not cached)
                self._remember_jobs(ctx, fc.name, result)
                yield CopilotChunk.tool(turn)
                parts.append(function_response_part(fc, result))
            contents.append({"role": "user", "parts": parts})

        yield CopilotChunk.answer(turn, final or self._compose_answer(turn, ctx, manifest), options=self._ambiguous_options(turn))

    # -- planner path ---------------------------------------------------------

    async def _planner_turn(
        self, ctx: CopilotContext, turn: TurnState, tools: Any, manifest: Manifest
    ) -> AsyncIterator[CopilotChunk]:
        turn.source = "planner"
        outcome = planner.plan(
            ctx.user_query,
            role=ctx.role,
            manifest=manifest,
            session_id=ctx.session_id,
            selected_job=ctx.selected_job,
            ui_context=ctx.ui_context,
            denied_mode=ctx.denied_mode,
            actor_name=ctx.display_name,
        )
        async for chunk in self._finish_planner(outcome, ctx, turn, tools, manifest):
            yield chunk

    async def _finish_planner(
        self, outcome: Any, ctx: CopilotContext, turn: TurnState, tools: Any, manifest: Manifest
    ) -> AsyncIterator[CopilotChunk]:
        if isinstance(outcome, planner.PlannerReply):
            if outcome.awaiting is not None:
                self.store.set_awaiting(ctx.session_id, outcome.awaiting)
            yield CopilotChunk.answer(turn, outcome.text, options=outcome.options)
            return

        call = turn.start_call(outcome.tool, outcome.args)
        yield CopilotChunk.tool(turn)
        try:
            result = await tools.execute(outcome.tool, dict(outcome.args))
        except ToolsUnavailable as exc:
            turn.fail_call(call, exc.code)
            yield CopilotChunk.error(UNREACHABLE_TEXT, turn)
            return
        if result.needs_confirmation:
            pending = PendingAction(
                tool=result.tool or outcome.tool,
                args=result.args if isinstance(result.args, dict) else dict(outcome.args),
                preview=result.preview or generic_preview(outcome.tool, outcome.args),
                created_at=self.store.now(),
                request_id=ctx.request_id,
            )
            self.store.set_pending(ctx.session_id, pending)
            turn.mark_needs_confirmation(call, pending.preview)
            yield CopilotChunk.confirm(turn, pending)
            return
        turn.finish_call(call, result)
        self._remember_jobs(ctx, outcome.tool, result)
        yield CopilotChunk.tool(turn)
        if not result.ok and result.error == "AMBIGUOUS" and result.candidates:
            arg = next((key for key in _AWAIT_ARG_KEYS if key in outcome.args), None)
            if arg is not None:
                self.store.set_awaiting(
                    ctx.session_id,
                    AwaitingInput(outcome.tool, dict(outcome.args), arg, list(result.candidates), self.store.now()),
                )
            yield CopilotChunk.answer(turn, error_text(result), options=self._candidate_labels(result))
            return
        yield CopilotChunk.answer(turn, error_text(result))

    # -- helpers ----------------------------------------------------------------

    @staticmethod
    def _candidate_labels(result: ToolResult) -> Optional[List[str]]:
        if result.error != "AMBIGUOUS" or not result.candidates:
            return None
        return [candidate["label"] for candidate in result.candidates][:6]

    def _ambiguous_options(self, turn: TurnState) -> Optional[List[str]]:
        """Labels of the last AMBIGUOUS result when no later call succeeded."""
        for call in reversed(turn.tool_calls):
            result = turn.results.get(call["id"])
            if result is None:
                continue
            if result.ok:
                return None
            if result.error == "AMBIGUOUS" and result.candidates:
                return self._candidate_labels(result)
        return None

    def _compose_answer(self, turn: TurnState, ctx: CopilotContext, manifest: Manifest) -> str:
        lines: List[str] = []
        for call in turn.tool_calls:
            result = turn.results.get(call["id"])
            if result is None:
                continue
            line = error_text(result)
            if line not in lines:
                lines.append(line)
        if not lines:
            return FALLBACK_UNKNOWN + "\n\n" + planner.capabilities_markdown(ctx.role, manifest)
        if len(lines) == 1:
            return lines[0]
        return "\n".join(f"- {line}" if "\n" not in line else line for line in lines)

    @staticmethod
    def _remember_jobs(ctx: CopilotContext, tool: str, result: ToolResult) -> None:
        """Keep "the 2nd job" consistent across agents (JOB-FEED.md §12.6 step 6)."""
        if not result.ok or not isinstance(result.data, dict):
            return
        try:
            if tool in ("jobs_search_campus", "jobs_search_market"):
                jobs = [job for job in (result.data.get("jobs") or []) if isinstance(job, dict)]
                if tool == "jobs_search_campus":
                    campus = [campus_item(job, student=ctx.role == "student") for job in jobs]
                    market: List[dict] = []
                else:
                    campus, market = [], [market_item(job) for job in jobs]
                items = merge_items(
                    campus, market,
                    campus_limit=max(len(campus), settings.JOBS_FINDER_CAMPUS_LIMIT),
                    max_results=max(len(campus) + len(market), 1),
                )
                if items:
                    session_job_store.replace_jobs(ctx.session_id, items)
            elif tool == "job_details":
                job = result.data.get("job") if isinstance(result.data.get("job"), dict) else None
                if job:
                    session_job_store.set_last_viewed_job(ctx.session_id, campus_item(job, student=ctx.role == "student"))
        except Exception:  # job memory is a convenience; never fail the turn for it
            log.warning("[%s] could not remember job results", ctx.request_id, exc_info=True)
