from __future__ import annotations

import re
from typing import Any, AsyncIterator, Dict, List, Optional

from app.schemas import QueryRequest
from app.agents.alumni_connect.schemas import AlumniConnectChunk
from app.agents.routing import RoutingRules


_sessions: Dict[str, Dict[str, Any]] = {}

_SEND_CONFIRMATION = re.compile(
    r"\balumni\s+connection\s+request\b.*\b(?:sent|created)\b",
    re.IGNORECASE | re.DOTALL,
)


def _tokens(value: Any) -> set[str]:
    return {
        token for token in re.findall(r"[a-z0-9+#.]+", str(value or "").lower())
        if len(token) > 1
    }


def _as_id(item: Dict[str, Any]) -> str:
    return str(item.get("_id") or item.get("id") or "")


def _rank_alumni(
    candidates: List[Dict[str, Any]], query: str, profile: Dict[str, Any], job: Optional[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    goal_tokens = _tokens(query)
    goal_tokens |= _tokens(profile.get("skills"))
    if job:
        goal_tokens |= _tokens(job.get("title") or job.get("roleTitle")) | _tokens(job.get("company_name") or job.get("companyName") or job.get("company"))
        goal_tokens |= _tokens(job.get("job_domain")) | _tokens(job.get("skills"))

    ranked = []
    for alumni in candidates:
        searchable = " ".join(str(alumni.get(key, "")) for key in (
            "name", "company", "currentRole", "branch", "bio", "skills", "mentoringTopics"
        ))
        score = len(goal_tokens & _tokens(searchable))
        if job and str(alumni.get("company", "")).lower() == str(job.get("company_name") or job.get("companyName") or job.get("company") or "").lower():
            score += 6
        if profile.get("branch") and str(alumni.get("branch", "")).lower() == str(profile.get("branch", "")).lower():
            score += 2
        ranked.append((score, str(alumni.get("name", "")), alumni))

    ranked.sort(key=lambda row: (-row[0], row[1]))
    return [item for _, _, item in ranked[:3]]


def _find_selected(
    req: QueryRequest, candidates: List[Dict[str, Any]], last_matches: List[Dict[str, Any]]
) -> Optional[Dict[str, Any]]:
    meta = req.meta_data or {}
    draft = req.alumni_request_draft
    requested_id = (draft.alumni_id if draft else "") or str(meta.get("alumni_id") or "")
    pool = candidates or last_matches
    if requested_id:
        return next((item for item in pool if _as_id(item) == requested_id), None)

    query = req.user_query.lower()
    ordinals = {"first": 0, "1st": 0, "second": 1, "2nd": 1, "third": 2, "3rd": 2}
    for word, index in ordinals.items():
        if word in query and index < len(last_matches):
            return last_matches[index]
    return next((item for item in last_matches if str(item.get("name", "")).lower() in query), None)


def _request_type(req: QueryRequest) -> str:
    if req.alumni_request_draft:
        return req.alumni_request_draft.request_type
    meta = req.meta_data or {}
    return str(meta.get("request_type") or "career-guidance")


def _draft_message(
    student: Dict[str, Any], alumni: Dict[str, Any], job: Optional[Dict[str, Any]], request_type: str
) -> str:
    student_name = student.get("name") or "a student from your college"
    alumni_name = alumni.get("name") or "there"
    role = alumni.get("currentRole") or "your field"
    company = alumni.get("company") or "your organization"
    goal = request_type.replace("-", " ")
    job_context = ""
    if job:
        title = job.get("title") or job.get("roleTitle") or "this role"
        target_company = job.get("company_name") or job.get("companyName") or job.get("company") or "the company"
        job_context = f" I’m currently preparing for the {title} opportunity at {target_company}."
    return (
        f"Hi {alumni_name}, I’m {student_name}, a student from our college.{job_context} "
        f"Your experience as {role} at {company} is closely related to the direction I’m pursuing. "
        f"Would you be open to a short conversation for {goal}? I’ll keep the discussion focused and work around your availability."
    )


def _is_resume_share_request(text: str) -> bool:
    normalized = (text or "").lower()
    return any(word in normalized for word in ("share", "send")) and any(word in normalized for word in ("resume", "cv"))


def _resume_share_draft(req: QueryRequest, meta: Dict[str, Any]) -> tuple[Optional[Dict[str, Any]], Optional[str]]:
    connections = list(meta.get("accepted_alumni_connections") or [])
    resumes = list(meta.get("resume_bank") or [])
    if not resumes:
        return None, "Your Resume Bank is empty. Complete a generated resume first, then ask me to share it."
    if not connections:
        return None, "You need an accepted alumni connection before a resume can be shared."

    if req.resume_share_draft:
        incoming = req.resume_share_draft.model_dump(exclude_none=True)
        connection = next((item for item in connections if _as_id(item) == incoming.get("connection_id")), None)
        resume = next((item for item in resumes if _as_id(item) == incoming.get("resume_version_id")), None)
        if not connection or not resume:
            return None, "That connection or resume version is no longer available."
        incoming["status"] = "reviewed"
        return incoming, None

    query = (req.user_query or "").lower()
    connection = next((item for item in connections if str(item.get("alumni", {}).get("name", "")).lower() in query), None)
    if not connection and len(connections) == 1:
        connection = connections[0]
    if not connection:
        names = ", ".join(item.get("alumni", {}).get("name", "Alumni") for item in connections)
        return None, f"Which accepted mentor should receive it? Available connections: {names}."

    def targets_company(item: Dict[str, Any]) -> bool:
        target_job = item.get("targetJob") or {}
        if not isinstance(target_job, dict):
            return False
        company = target_job.get("companyName") or target_job.get("company_name")
        return any(token in query for token in _tokens(company))

    resume = next((item for item in resumes if str(item.get("title", "")).lower() in query), None)
    if not resume:
        resume = next((item for item in resumes if targets_company(item)), None)
    resume = resume or resumes[0]
    alumni_name = connection.get("alumni", {}).get("name", "your mentor")
    return {
        "connection_id": _as_id(connection),
        "alumni_name": alumni_name,
        "resume_version_id": _as_id(resume),
        "resume_title": resume.get("title", "Generated Resume"),
        "resume_version": resume.get("version", 1),
        "message": f"Thanks, {alumni_name}. Here is the resume I prepared for your review.",
        "status": "reviewed",
    }, None


class AlumniConnectAgent:
    """Matches students with alumni and prepares reviewable connection requests."""

    name = "alumni-connect"

    ROUTING_RULES = RoutingRules(
        strong=(
            r"\b(find|show|recommend|connect|match|introduce)\b[^.?!]{0,45}\b(alumni|alumnus|alumna|mentor)\b",
            r"\b(alumni|alumnus|alumna|mentor)\b[^.?!]{0,45}\b(guidance|mentorship|advice|review|connect|match)\b",
            r"\b(share|send)\b[^.?!]{0,30}\b(resume|cv)\b[^.?!]{0,45}\b(with|to)\b",
            r"\b(share|send)\b[^.?!]{0,20}\b(my|latest|saved|this)?\s*(resume|cv)\b",
        ),
        weak=(r"\balumni\b", r"\balumnus\b", r"\balumna\b", r"\bmentors?\b", r"\bmentorship\b"),
        veto=(r"\bmock\s+interview\b",),
    )
    SWITCH_MESSAGE = "Sure -- let's connect you with the right alumni mentor."
    emits_own_chunks = True
    content_header = AlumniConnectChunk.HEADER_IN_PROGRESS

    @staticmethod
    def error_chunk(message: str, session_id: str = "") -> AlumniConnectChunk:
        return AlumniConnectChunk.message(message)

    async def run(self, req: QueryRequest) -> AsyncIterator[Any]:
        if _SEND_CONFIRMATION.search(req.user_query or ""):
            _sessions.pop(req.sessionId, None)
            yield AlumniConnectChunk.completion()
            return

        session = _sessions.setdefault(req.sessionId, {"matches": [], "draft": None})
        meta = req.meta_data or {}
        candidates = list(meta.get("candidate_alumni") or [])
        profile = dict(meta.get("profile") or {})
        selected_job = meta.get("selected_job")

        if req.resume_share_draft or _is_resume_share_request(req.user_query):
            share_draft, error = _resume_share_draft(req, meta)
            if error:
                yield AlumniConnectChunk.message(error)
            else:
                session["resume_share_draft"] = share_draft
                yield AlumniConnectChunk.resume_share_review(share_draft)
            return

        selected = _find_selected(req, candidates, session["matches"])
        if req.alumni_request_draft and selected:
            incoming = req.alumni_request_draft.model_dump(exclude_none=True)
            incoming["alumni_name"] = incoming.get("alumni_name") or selected.get("name", "")
            incoming["selected_job"] = incoming.get("selected_job") or selected_job
            if incoming.get("share_resume"):
                incoming["resume"] = incoming.get("resume") or str(meta.get("resume") or "")
            else:
                incoming["resume"] = ""
            incoming["status"] = "reviewed"
            session["draft"] = incoming
            yield AlumniConnectChunk.review(incoming)
            return

        wants_request = bool(selected) or any(word in (req.user_query or "").lower() for word in (
            "connect", "request", "choose", "select", "mentor me", "draft"
        ))
        if selected and wants_request:
            request_type = _request_type(req)
            share_resume = bool(meta.get("share_resume"))
            draft = {
                "alumni_id": _as_id(selected),
                "alumni_name": selected.get("name", ""),
                "request_type": request_type,
                "message": _draft_message(profile, selected, selected_job, request_type),
                "selected_job": selected_job,
                "share_resume": share_resume,
                "resume": str(meta.get("resume") or "") if share_resume else "",
                "status": "reviewed",
            }
            session["draft"] = draft
            yield AlumniConnectChunk.review(draft)
            return

        matches = _rank_alumni(candidates, req.user_query, profile, selected_job)
        session["matches"] = matches
        if matches:
            yield AlumniConnectChunk.matches(matches)
            return

        yield AlumniConnectChunk.message(
            "I couldn’t find an available alumnus for that goal yet. Try a broader mentorship topic, or check again after more alumni complete onboarding."
        )
