"""Session-aware metadata-first job eligibility agent."""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any, AsyncIterator, Dict, Iterable, List, Optional

from pydantic import ValidationError

from app.schemas import QueryRequest
from app.agents.job_eligibility.models import (
    AnomalyFlag,
    EligibilityCriteria,
    OverrideRecord,
    Severity,
    StudentProfile,
)
from app.agents.job_eligibility.rules_engine import evaluate_eligibility
from app.agents.job_eligibility.anomaly_detector import detect_anomalies, detect_rule_conflicts
from app.agents.job_eligibility.gemini_client import interpret_query
from app.agents.job_eligibility.job_eligiblity_header_message import JOB_DETAILS_HEADER_MESSAGE
from app.agents.job_eligibility.session import EligibilitySessionState, get_or_create_session
from app.agents.routing import RoutingRules

logger = logging.getLogger(__name__)

_FRIENDLY_FIELD_NAMES = {
    "student_id": "a student identifier",
    "branch": "the student's branch",
    "cgpa": "the student's CGPA",
    "active_backlogs": "the student's active backlog count",
    "job_id": "a job identifier",
    "job_title": "the job/role title",
    "tpo_staff_id": "which TPO staff member made the override",
    "rule_engine_verdict": "the rule engine's original verdict for that override",
    "override_verdict": "what the override changed the verdict to",
}

_DETAIL_PATTERNS = (
    "tell me about",
    "more about",
    "job details",
    "details about",
    "describe this job",
    "about this job",
    "about the company",
)

_MATCH_STOP_WORDS = {
    "a", "about", "am", "an", "and", "apply", "check", "company", "eligibility",
    "eligible", "for", "i", "in", "intern", "internship", "is", "job", "jobs", "me",
    "my", "of", "role", "tell", "the", "this", "to", "want",
}


def _is_present(value: Any) -> bool:
    return value is not None and value != "" and value != []


def _job_title(job: Dict[str, Any]) -> str:
    return str(job.get("job_title") or job.get("title") or "Available role")


def _company_name(job: Dict[str, Any]) -> str:
    company = job.get("company")
    if isinstance(company, dict):
        company = company.get("name")
    return str(job.get("company_name") or company or "Unknown company")


def _job_value(job: Dict[str, Any], snake_name: str, camel_name: str, default: Any = None) -> Any:
    value = job.get(snake_name)
    return job.get(camel_name, default) if value is None else value


def _markdown_cell(value: Any) -> str:
    return str(value).replace("|", "\\|").replace("\n", " ").strip()


class JobEligibilityAgent:
    """Evaluate metadata jobs using profile data remembered per chat session.

    Node supplies the authoritative profile and active jobs in ``meta_data``.
    The agent merges that data into a session map, asks only for a value that
    is genuinely missing, validates CGPA locally, and remembers the selected
    job so follow-ups such as "tell me about this job" are deterministic.
    Gemini remains a narrow fallback for legacy free-text audit payloads; it
    never decides the eligibility verdict.
    """

    name = "job-eligibility"

    ROUTING_RULES = RoutingRules(
        strong=(
            r"\b(am|are)\s+i\s+eligible\b",
            r"\bcan\s+i\s+apply\b",
            r"\bwhy\s+(was|am)\s+i\s+(disqualified|ineligible|rejected)\b",
            r"\baudit\b[^.?!]{0,25}\b(overrides?|rules?|anomal(y|ies))\b",
            r"\bcheck\s+(my|his|her|their)\s+eligibilit(y|ies)\b",
        ),
        weak=(r"\beligible\b", r"\beligibilit(y|ies)\b", r"\bcgpa\b", r"\bbacklogs?\b", r"\boverrides?\b"),
    )
    SWITCH_MESSAGE = "Sure -- let's check your eligibility."

    async def run(self, req: QueryRequest) -> AsyncIterator[Any]:
        state = get_or_create_session(req.sessionId)
        state.merge_metadata(req.meta_data)

        try:
            payload = self._parse_payload(req.user_query)
            if payload is not None:
                async for chunk in self._dispatch(payload):
                    yield chunk
                return

            query = (req.user_query or "").strip()
            if self._is_details_request(query):
                detail_job = self._resolve_detail_job(query, state)
                if detail_job is not None:
                    state.last_job_id = str(detail_job["job_id"])
                    yield {
                        "type": "job_details",
                        "header_message": JOB_DETAILS_HEADER_MESSAGE,
                        "content": self._format_job_details(detail_job),
                        "data": detail_job,
                    }
                else:
                    yield "I don't have a previously selected job in this chat yet. Ask me to check your eligibility first.\n"
                return

            if self._is_audit_request(query):
                async for chunk in self._run_llm_fallback(query, req, state):
                    yield chunk
                return

            async for chunk in self._run_metadata_check(query, req, state):
                yield chunk
        except Exception as exc:
            logger.exception("[%s] job-eligibility agent failed", req.requestId)
            yield f"Could not evaluate eligibility: {exc}\n"

    async def _run_metadata_check(
        self,
        query: str,
        req: QueryRequest,
        state: EligibilitySessionState,
    ) -> AsyncIterator[Any]:
        validation_message = self._capture_profile_reply(query, state)
        if validation_message:
            yield validation_message + "\n"
            return

        selected_jobs = self._select_jobs(query, state)
        if not selected_jobs:
            if not state.jobs_by_id:
                yield "I don't have any active jobs in the metadata yet. Please ask your placement team to publish a job first.\n"
            else:
                yield "I couldn't match that request to an active job. Please mention the company or role name.\n"
            return

        state.selected_job_ids = [str(job["job_id"]) for job in selected_jobs]
        missing_field = self._next_missing_profile_field(state.profile, selected_jobs)
        if missing_field:
            state.awaiting_field = missing_field
            yield self._missing_field_question(missing_field) + "\n"
            return

        state.awaiting_field = None
        student = self._student_from_state(state, req.sessionId)
        rows: List[tuple[Dict[str, Any], Any]] = []
        for job in selected_jobs:
            criteria = self._criteria_from_job(job)
            verdict = evaluate_eligibility(student, criteria)
            rows.append((job, verdict))

        eligible_rows = [row for row in rows if row[1].rule_engine_eligible]
        state.last_job_id = str((eligible_rows or rows)[0][0]["job_id"])
        yield self._format_eligibility_table(rows, student.cgpa) + "\n"

        for job, verdict in rows:
            yield {
                "type": "eligibility_result",
                "job": str(job["job_id"]),
                "job_title": _job_title(job),
                "company": _company_name(job),
                "student": student.student_id,
                "isEligible": verdict.rule_engine_eligible,
                "status": "eligible" if verdict.rule_engine_eligible else "ineligible",
                "explanation": verdict.explanation,
            }

    def _capture_profile_reply(self, query: str, state: EligibilitySessionState) -> Optional[str]:
        text = query.strip()
        cgpa_match = re.search(r"\bcgpa\s*(?:is|=|:)?\s*(-?\d+(?:\.\d+)?)", text, re.IGNORECASE)
        if state.awaiting_field == "cgpa" and not cgpa_match:
            cgpa_match = re.fullmatch(r"\s*(-?\d+(?:\.\d+)?)\s*", text)
        if cgpa_match:
            cgpa = float(cgpa_match.group(1))
            if not 0 <= cgpa <= 10:
                state.awaiting_field = "cgpa"
                return "CGPA must be between 0 and 10. Please enter a valid CGPA"
            state.profile["cgpa"] = cgpa

        backlog_match = re.search(r"(?:active\s+)?backlogs?\s*(?:is|are|=|:)?\s*(\d+)", text, re.IGNORECASE)
        if state.awaiting_field == "active_backlogs" and not backlog_match:
            backlog_match = re.fullmatch(r"\s*(\d+)\s*", text)
        if backlog_match:
            state.profile["active_backlogs"] = int(backlog_match.group(1))

        graduation_match = re.search(r"(?:graduation|passing)\s+year\s*(?:is|=|:)?\s*(20\d{2})", text, re.IGNORECASE)
        if state.awaiting_field == "graduation_year" and not graduation_match:
            graduation_match = re.fullmatch(r"\s*(20\d{2})\s*", text)
        if graduation_match:
            state.profile["graduation_year"] = int(graduation_match.group(1))

        branch_match = re.search(r"\bbranch\s*(?:is|=|:)?\s*([A-Za-z][A-Za-z &.-]{1,40})", text, re.IGNORECASE)
        if state.awaiting_field == "branch" and not branch_match and re.fullmatch(r"[A-Za-z][A-Za-z &.-]{1,40}", text):
            branch_match = re.fullmatch(r"([A-Za-z][A-Za-z &.-]{1,40})", text)
        if branch_match:
            state.profile["branch"] = branch_match.group(1).strip()

        return None

    @staticmethod
    def _next_missing_profile_field(profile: Dict[str, Any], jobs: Iterable[Dict[str, Any]]) -> Optional[str]:
        try:
            cgpa = float(profile.get("cgpa"))
        except (TypeError, ValueError):
            cgpa = None
        if cgpa is None or not 0 <= cgpa <= 10:
            return "cgpa"

        jobs = list(jobs)
        if any(_job_value(job, "allowed_branches", "eligibleBranches", []) for job in jobs) and not _is_present(profile.get("branch")):
            return "branch"
        if any(_job_value(job, "max_backlogs", "maximumBacklogs") is not None for job in jobs) and not _is_present(profile.get("active_backlogs")):
            return "active_backlogs"
        if any(_job_value(job, "allowed_graduation_years", "graduationYears", []) for job in jobs) and not _is_present(profile.get("graduation_year")):
            return "graduation_year"
        return None

    @staticmethod
    def _missing_field_question(field: str) -> str:
        return {
            "cgpa": "I don't have your CGPA yet. Please tell me your CGPA (a number between 0 and 10).",
            "branch": "I don't have your branch yet. Please tell me your branch.",
            "active_backlogs": "How many active backlogs do you currently have?",
            "graduation_year": "What is your graduation year?",
        }[field]

    @staticmethod
    def _student_from_state(state: EligibilitySessionState, session_id: str) -> StudentProfile:
        profile = state.profile
        return StudentProfile(
            student_id=str(profile.get("student_id") or session_id),
            name=str(profile.get("name") or "Student"),
            branch=str(profile.get("branch") or "Not mentioned"),
            cgpa=float(profile["cgpa"]),
            active_backlogs=int(profile.get("active_backlogs") or 0),
            tenth_percentage=profile.get("tenth_percentage"),
            twelfth_percentage=profile.get("twelfth_percentage"),
            graduation_year=profile.get("graduation_year"),
            category=str(profile.get("category") or "General"),
            experience_months=int(profile.get("experience_months") or 0),
        )

    @staticmethod
    def _criteria_from_job(job: Dict[str, Any]) -> EligibilityCriteria:
        return EligibilityCriteria(
            job_id=str(job["job_id"]),
            job_title=f"{_job_title(job)} at {_company_name(job)}",
            min_cgpa=_job_value(job, "min_cgpa", "minimumCgpa"),
            max_backlogs=_job_value(job, "max_backlogs", "maximumBacklogs"),
            allowed_branches=_job_value(job, "allowed_branches", "eligibleBranches", []) or [],
            allowed_graduation_years=[
                int(year) for year in (_job_value(job, "allowed_graduation_years", "graduationYears", []) or [])
                if str(year).isdigit()
            ],
        )

    def _select_jobs(self, query: str, state: EligibilitySessionState) -> List[Dict[str, Any]]:
        jobs = list(state.jobs_by_id.values())
        if not jobs:
            return []

        if state.awaiting_field and state.selected_job_ids:
            return [state.jobs_by_id[job_id] for job_id in state.selected_job_ids if job_id in state.jobs_by_id]

        matches = self._match_jobs(query, jobs)
        if matches:
            return matches
        if state.selected_job_ids and not self._looks_like_new_eligibility_request(query):
            return [state.jobs_by_id[job_id] for job_id in state.selected_job_ids if job_id in state.jobs_by_id]
        if self._looks_like_new_eligibility_request(query):
            return jobs
        return [jobs[0]] if len(jobs) == 1 else []

    @staticmethod
    def _match_jobs(query: str, jobs: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
        lowered = query.casefold()
        query_tokens = set(re.findall(r"[a-z0-9+#.]+", lowered)) - _MATCH_STOP_WORDS
        scored: List[tuple[int, Dict[str, Any]]] = []
        for job in jobs:
            title = _job_title(job).casefold()
            company = _company_name(job).casefold()
            if (len(title) > 2 and title in lowered) or (len(company) > 2 and company in lowered):
                scored.append((100, job))
                continue
            job_tokens = set(re.findall(r"[a-z0-9+#.]+", f"{title} {company}")) - _MATCH_STOP_WORDS
            score = len(query_tokens & job_tokens)
            if score:
                scored.append((score, job))
        if not scored:
            return []
        best = max(score for score, _ in scored)
        return [job for score, job in scored if score == best]

    @staticmethod
    def _looks_like_new_eligibility_request(query: str) -> bool:
        lowered = query.casefold()
        return any(term in lowered for term in ("eligible", "eligibility", "qualify", "can i apply"))

    @staticmethod
    def _is_details_request(query: str) -> bool:
        lowered = query.casefold()
        return any(pattern in lowered for pattern in _DETAIL_PATTERNS)

    @staticmethod
    def _is_audit_request(query: str) -> bool:
        lowered = query.casefold()
        return any(term in lowered for term in ("audit", "override", "anomaly", "rule conflict"))

    def _resolve_detail_job(self, query: str, state: EligibilitySessionState) -> Optional[Dict[str, Any]]:
        matches = self._match_jobs(query, state.jobs_by_id.values())
        if matches:
            return matches[0]
        if state.last_job_id and state.last_job_id in state.jobs_by_id:
            return state.jobs_by_id[state.last_job_id]
        if len(state.selected_job_ids) == 1:
            return state.jobs_by_id.get(state.selected_job_ids[0])
        return None

    @staticmethod
    def _format_eligibility_table(rows: List[tuple[Dict[str, Any], Any]], cgpa: float) -> str:
        eligible_jobs = [
            f"**{_markdown_cell(_job_title(job))}** at **{_markdown_cell(_company_name(job))}**"
            for job, verdict in rows
            if verdict.rule_engine_eligible
        ]
        ineligible_jobs = [
            f"**{_markdown_cell(_job_title(job))}** at **{_markdown_cell(_company_name(job))}**"
            for job, verdict in rows
            if not verdict.rule_engine_eligible
        ]

        if len(rows) == 1:
            job, verdict = rows[0]
            if verdict.rule_engine_eligible:
                summary = f"You are eligible for the **{_job_title(job)}** job at **{_company_name(job)}**."
            else:
                summary = f"You are not eligible for the **{_job_title(job)}** job at **{_company_name(job)}**."
        else:
            summary_parts = []
            if eligible_jobs:
                summary_parts.append(f"You are eligible for {', '.join(eligible_jobs)}.")
            if ineligible_jobs:
                summary_parts.append(f"You are not eligible for {', '.join(ineligible_jobs)}.")
            summary = "\n\n".join(summary_parts)

        lines = [
            summary,
            "",
            f"## Eligibility Results (CGPA: {cgpa:.2f})",
            "",
            "| Job | Company | Result | Reason |",
            "|---|---|---|---|",
        ]
        for job, verdict in rows:
            result = "Eligible" if verdict.rule_engine_eligible else "Not eligible"
            failed = [item for item in verdict.criteria_results if not item.passed]
            if failed:
                reason = "; ".join(f"{item.criterion}: requires {item.required}, you have {item.actual}" for item in failed)
            elif verdict.criteria_results:
                reason = "All configured criteria are satisfied"
            else:
                reason = "No restrictive eligibility criteria are configured"
            lines.append(
                f"| {_markdown_cell(_job_title(job))} | {_markdown_cell(_company_name(job))} "
                f"| **{result}** | {_markdown_cell(reason)} |"
            )
        return "\n".join(lines)

    @staticmethod
    def _format_job_details(job: Dict[str, Any]) -> str:
        branches = _job_value(job, "allowed_branches", "eligibleBranches", []) or []
        skills = job.get("skills") or []
        deadline = _job_value(job, "application_deadline", "applicationDeadline") or "Not specified"
        return "\n".join([
            f"## {_job_title(job)}",
            f"**Company:** {_company_name(job)}",
            "",
            str(job.get("description") or "No description has been provided for this job."),
            "",
            f"- **Location:** {job.get('location') or 'Not specified'}",
            f"- **Employment type:** {_job_value(job, 'employment_type', 'employmentType') or 'Not specified'}",
            f"- **Salary:** {job.get('salary') or 'Not disclosed'}",
            f"- **Minimum CGPA:** {_job_value(job, 'min_cgpa', 'minimumCgpa') if _job_value(job, 'min_cgpa', 'minimumCgpa') is not None else 'Not specified'}",
            f"- **Eligible branches:** {', '.join(map(str, branches)) if branches else 'All branches'}",
            f"- **Skills:** {', '.join(map(str, skills)) if skills else 'Not specified'}",
            f"- **Application deadline:** {deadline}",
            f"- **Selection process:** {_job_value(job, 'selection_process', 'selectionProcess') or 'Not specified'}",
        ]) + "\n"

    async def _run_llm_fallback(
        self,
        query: str,
        req: QueryRequest,
        state: EligibilitySessionState,
    ) -> AsyncIterator[Any]:
        payload = await interpret_query(
            query,
            metadata=req.meta_data,
            session_context={
                "profile": state.profile,
                "selected_job_ids": state.selected_job_ids,
                "last_job_id": state.last_job_id,
            },
        )
        if payload is None:
            yield "I couldn't interpret that eligibility request right now. Please try again.\n"
            return
        async for chunk in self._dispatch(payload):
            yield chunk

    async def _dispatch(self, payload: Dict[str, Any]) -> AsyncIterator[Any]:
        action = (payload.get("action") or "").lower()
        if action == "clarify":
            yield (payload.get("message") or "Could you provide the missing eligibility information?") + "\n"
        elif action == "audit":
            async for chunk in self._run_audit(payload):
                yield chunk
        else:
            async for chunk in self._run_structured_check(payload):
                yield chunk

    async def _run_structured_check(self, payload: Dict[str, Any]) -> AsyncIterator[Any]:
        if not payload.get("student"):
            yield "I need the student's profile before I can check eligibility.\n"
            return
        if not payload.get("criteria"):
            yield "I need the job criteria before I can check eligibility.\n"
            return
        try:
            student = StudentProfile(**payload["student"])
            criteria = EligibilityCriteria(**payload["criteria"])
        except ValidationError as exc:
            yield self._missing_fields_prompt(exc) + "\n"
            return

        verdict = evaluate_eligibility(student, criteria)
        conflicts = detect_rule_conflicts(criteria)
        if conflicts:
            yield "This posting has unresolved eligibility-rule conflicts:\n"
            for conflict in conflicts:
                yield f"- {conflict.description}\n"
            yield "\n"
        yield verdict.explanation + "\n"
        yield {
            "type": "eligibility_result",
            "job": criteria.job_id,
            "job_title": criteria.job_title,
            "student": student.student_id,
            "isEligible": verdict.rule_engine_eligible,
            "status": "eligible" if verdict.rule_engine_eligible else "ineligible",
            "explanation": verdict.explanation,
        }

    async def _run_audit(self, payload: Dict[str, Any]) -> AsyncIterator[Any]:
        if not payload.get("criteria_list") and not payload.get("overrides"):
            yield "Which job posting or override would you like me to audit?\n"
            return
        try:
            criteria_list = [EligibilityCriteria(**item) for item in payload.get("criteria_list", [])]
            overrides = [OverrideRecord(**item) for item in payload.get("overrides", [])]
        except ValidationError as exc:
            yield self._missing_fields_prompt(exc) + "\n"
            return

        await asyncio.sleep(0.01)
        flags = detect_anomalies(criteria_list, overrides)
        if not flags:
            yield "No eligibility-rule or override anomalies were found.\n"
            return
        grouped: Dict[Severity, List[AnomalyFlag]] = {severity: [] for severity in Severity}
        for flag in flags:
            grouped[flag.severity].append(flag)
        for severity in (Severity.HIGH, Severity.MEDIUM, Severity.LOW):
            if not grouped[severity]:
                continue
            yield f"### {severity.value.title()} severity\n"
            for flag in grouped[severity]:
                yield f"- {flag.description}\n"

    @staticmethod
    def _parse_payload(user_query: str) -> Optional[Dict[str, Any]]:
        text = (user_query or "").strip()
        if not (text.startswith("{") and text.endswith("}")):
            return None
        try:
            parsed = json.loads(text)
            return parsed if isinstance(parsed, dict) else None
        except json.JSONDecodeError:
            return None

    @staticmethod
    def _missing_fields_prompt(exc: ValidationError) -> str:
        missing = sorted({str(error["loc"][-1]) for error in exc.errors() if error.get("type") == "missing"})
        if not missing:
            return f"I couldn't validate that eligibility data: {exc.errors()[0].get('msg', 'invalid value')}"
        fields = [_FRIENDLY_FIELD_NAMES.get(field, field.replace("_", " ")) for field in missing]
        return f"Please provide {', '.join(fields)}."
