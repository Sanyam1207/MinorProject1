"""Role matrix: which agent modes each user role may be routed to.

Python's role checks are a UX layer -- Node re-authorizes every tool call and
every persistence hook -- but they keep students out of TPO-only agents and
send teachers, recruiters and alumni to the copilot, whose tools are filtered
by role on the server.
"""

from __future__ import annotations

from typing import Dict, FrozenSet, Optional

from app.agents.modes import AgentMode
from app.schemas import QueryRequest

ROLES = ("student", "teacher", "tpo", "admin", "company", "alumni")

_STAFF_MODES = frozenset({
    AgentMode.COPILOT,
    AgentMode.JOBS,
    AgentMode.ELIGIBILITY,
    AgentMode.JOB_CREATION,
    AgentMode.GAP_ANALYSIS,
    AgentMode.PR_OUTREACH,
})

# Single source of truth. The copilot is always allowed.
ROLE_MODES: Dict[str, FrozenSet[AgentMode]] = {
    "student": frozenset({
        AgentMode.COPILOT,
        AgentMode.JOBS,
        AgentMode.ELIGIBILITY,
        AgentMode.RESUME,
        AgentMode.INTERVIEW,
        AgentMode.LEARNING_RECOMMENDATION,
        AgentMode.PR_OUTREACH,
        AgentMode.ALUMNI_CONNECT,
    }),
    "teacher": frozenset({AgentMode.COPILOT}),
    "tpo": _STAFF_MODES,
    "admin": _STAFF_MODES,
    "company": frozenset({AgentMode.COPILOT}),
    "alumni": frozenset({AgentMode.COPILOT}),
}

SPECIALIST_PHRASES: Dict[AgentMode, str] = {
    AgentMode.JOBS: 'job search and careers-page scanning ("find python jobs in Pune")',
    AgentMode.ELIGIBILITY: 'eligibility checks ("am I eligible for the Infosys drive?")',
    AgentMode.RESUME: 'the resume builder ("build my resume")',
    AgentMode.INTERVIEW: 'mock interviews ("start a mock interview")',
    AgentMode.LEARNING_RECOMMENDATION: 'learning plans from past interviews ("what should I study to improve?")',
    AgentMode.PR_OUTREACH: 'outreach emails ("draft an email to HR at TCS")',
    AgentMode.ALUMNI_CONNECT: 'alumni mentors ("connect me with an alumni mentor")',
    AgentMode.JOB_CREATION: 'posting a job by chat ("post a job for Infosys")',
    AgentMode.GAP_ANALYSIS: 'curriculum gap analysis ("do a gap analysis of the curriculum")',
}

ROLE_DENIED_TEXT: Dict[AgentMode, str] = {
    AgentMode.JOB_CREATION: "Posting jobs by chat is available to TPO accounts.",
    AgentMode.GAP_ANALYSIS: "Curriculum gap analysis is available to TPO/HOD accounts.",
    AgentMode.RESUME: "The resume builder is available to student accounts.",
    AgentMode.INTERVIEW: "Mock interviews are available to student accounts.",
    AgentMode.LEARNING_RECOMMENDATION: "Learning plans are available to student accounts.",
    AgentMode.ALUMNI_CONNECT: "Alumni mentor matching is available to student accounts.",
    AgentMode.JOBS: "Job search by chat is available to student and TPO accounts.",
    AgentMode.ELIGIBILITY: "Eligibility checks are available to student and TPO accounts.",
    AgentMode.PR_OUTREACH: "Outreach email drafting is available to student and TPO accounts.",
}

ROLE_LABELS: Dict[str, str] = {
    "student": "student",
    "teacher": "teacher",
    "tpo": "training & placement officer",
    "admin": "administrator",
    "company": "company recruiter",
    "alumni": "alumnus",
}


def normalize_role(value: object) -> str:
    """Lower-cased role; anything unknown becomes ``"student"``."""
    role = value.strip().lower() if isinstance(value, str) else ""
    return role if role in ROLES else "student"


def resolve_role(req: QueryRequest) -> str:
    """``meta_data.actor.role`` (authoritative), else ``user_role``, else student.

    Node sends ``user_role: "tpo"`` but ``actor.role: "admin"`` for admins --
    the actor wins.
    """
    meta = req.meta_data if isinstance(req.meta_data, dict) else {}
    actor = meta.get("actor")
    if isinstance(actor, dict):
        role = actor.get("role")
        if isinstance(role, str) and role.strip():
            return normalize_role(role)
    if isinstance(req.user_role, str) and req.user_role.strip():
        return normalize_role(req.user_role)
    return "student"


def allowed_modes(role: Optional[str]) -> FrozenSet[AgentMode]:
    """Modes *role* may use; ``None`` means every mode (no filtering)."""
    if role is None:
        return frozenset(AgentMode)
    return ROLE_MODES.get(normalize_role(role), ROLE_MODES["student"])


def is_mode_allowed(mode: AgentMode, role: Optional[str]) -> bool:
    return mode in allowed_modes(role)


def specialist_modes(role: Optional[str]) -> list[AgentMode]:
    """Allowed non-copilot modes in ``AgentMode`` order."""
    allowed = allowed_modes(role)
    return [mode for mode in AgentMode if mode in allowed and mode is not AgentMode.COPILOT]
