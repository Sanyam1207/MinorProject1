"""Gap Analysis Agent.

Registered in ``app/agents/__init__.py`` under the name ``"gap-analysis"``.

Architecture
------------
The HOD has a multi-turn conversation with the agent. On every turn:
1. Extract current_curriculum, available_electives, industry_skills from meta_data.
2. Build a rich user turn with all data context.
3. Call Gemini for analysis.
4. Parse the structured JSON block from the response.
5. Yield a GapAnalysisChunk with the prose, structured data, options, and confidence.

The agent supports:
- Offering clickable option buttons to guide the HOD.
- Asking clarifying questions.
- Providing detailed gap tables and elective suggestions with confidence scores.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, AsyncIterator, Dict, List, Optional

from app.schemas import QueryRequest
from app.agents.routing import RoutingRules
from app.agents.gap_analysis.schemas import GapAnalysisChunk
from app.agents.gap_analysis.prompt import SYSTEM_PROMPT, build_user_turn

log = logging.getLogger("gap_analysis.agent")


class GapAnalysisAgent:
    """Gap Analysis Agent — analyses curriculum-vs-industry gaps and
    suggests electives to bridge them, in a multi-turn conversation.
    """

    name = "gap-analysis"

    ROUTING_RULES = RoutingRules(
        strong=(
            r"\bgap\s+analysis\b",
            r"\bcurriculum\s+gap\b",
            r"\bskill\s+gap.*curriculum\b",
            r"\bcurriculum.*skill\s+gap\b",
            r"\bsuggest\s+elective\b",
            r"\belective\s+suggest\b",
            r"\belective\s+recommendation\b",
            r"\banalyse?\s+curriculum\b",
            r"\bcurriculum\s+analys[ei]s\b",
        ),
        weak=(
            r"\belective\b",
            r"\bcurriculum\b",
            r"\bsyllabus\b",
            r"\bindustry\s+skill\b",
            r"\bskill\s+gap\b",
        ),
        veto=(
            r"\bmock\s+interview\b",
            r"\bresume\b",
            r"\bjob\s+post\b",
        ),
    )

    SWITCH_MESSAGE = "Let's analyse the curriculum-to-industry gap."

    # run() yields GapAnalysisChunk objects — the orchestrator emits them verbatim.
    emits_own_chunks = True
    content_header = GapAnalysisChunk.HEADER_ANALYSIS

    @staticmethod
    def error_chunk(message: str, session_id: str = "") -> GapAnalysisChunk:
        return GapAnalysisChunk.error_chunk(response=message)

    async def run(self, req: QueryRequest) -> AsyncIterator[Any]:
        # ── 1. Authorization — only TPO can use gap analysis ─────────────
        raw_role = (getattr(req, "user_role", None) or "").strip().lower()
        if raw_role != "tpo":
            yield GapAnalysisChunk.error_chunk(
                response=(
                    "Gap analysis is only available for HOD / TPO users. "
                    "Please switch to a TPO account to use this feature."
                ),
            )
            return

        # ── 2. Extract data from meta_data ────────────────────────────────
        meta_data: Dict[str, Any] = req.meta_data or {}
        current_curriculum = meta_data.get("current_curriculum", [])
        available_electives = meta_data.get("available_electives", [])
        industry_skills = meta_data.get("industry_skills", [])

        if not current_curriculum and not industry_skills:
            yield GapAnalysisChunk.analysis_chunk(
                response=(
                    "I don't have enough data to perform a gap analysis right now. "
                    "Please make sure there are active job postings and curriculum "
                    "data available in the system."
                ),
                options=["Try again", "Show available data"],
                is_end=True,
            )
            return

        try:
            chunk = await self._handle(
                req=req,
                user_message=req.user_query,
                current_curriculum=current_curriculum,
                available_electives=available_electives,
                industry_skills=industry_skills,
            )
            yield chunk
        except Exception as exc:
            log.exception("[%s] gap-analysis agent error", req.requestId)
            yield GapAnalysisChunk.error_chunk(
                response=f"Something went wrong while processing your request: {exc}",
            )

    async def _handle(
        self,
        req: QueryRequest,
        user_message: str,
        current_curriculum: Any,
        available_electives: Any,
        industry_skills: Any,
    ) -> GapAnalysisChunk:
        """Single-turn handler: build context, call Gemini, parse and return chunk."""

        # Build conversation history from past_messages
        history: List[Dict[str, Any]] = []
        if req.past_messages:
            for pm in req.past_messages:
                role = "user" if pm.role == "user" else "model"
                history.append({"role": role, "parts": [{"text": pm.content}]})

        # Build the user turn with all data
        user_turn = build_user_turn(
            current_curriculum=current_curriculum,
            available_electives=available_electives,
            industry_skills=industry_skills,
            user_message=user_message,
        )

        # Call Gemini
        from app.agents.gap_analysis.llm import call_gemini_chat
        llm_reply = await call_gemini_chat(
            system_prompt=SYSTEM_PROMPT,
            history=history,
            user_turn=user_turn,
        )

        # Parse the JSON block from LLM reply
        extracted = _extract_json_block(llm_reply) or {}
        clean_reply = _strip_json_block(llm_reply).strip()

        # Extract structured data
        action = (extracted.get("action") or "analyze").lower()
        gaps = extracted.get("gaps", [])
        suggestions = extracted.get("suggestions", [])
        options = extracted.get("options")
        overall_confidence = extracted.get("overall_confidence")

        # Validate confidence
        if overall_confidence is not None:
            try:
                overall_confidence = float(overall_confidence)
                overall_confidence = max(0.0, min(1.0, overall_confidence))
            except (TypeError, ValueError):
                overall_confidence = None

        # Use clean_reply or a fallback
        response_text = clean_reply or llm_reply or (
            "I'm analysing the gap between your curriculum and industry demands. "
            "Let me know if you'd like to focus on a specific area."
        )

        # Decide which chunk type to emit
        if suggestions and action in ("suggest", "analyze"):
            return GapAnalysisChunk.suggestions_chunk(
                response=response_text,
                suggestions=suggestions,
                confidence_score=overall_confidence,
                options=options,
                is_end=True,
            )
        else:
            return GapAnalysisChunk.analysis_chunk(
                response=response_text,
                gaps=gaps,
                suggestions=suggestions,
                options=options,
                confidence_score=overall_confidence,
                is_end=True,
            )


# ---------------------------------------------------------------------------
# JSON extraction helpers (same as job_creator/agent.py)
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
