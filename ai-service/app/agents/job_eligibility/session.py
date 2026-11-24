"""In-process conversation state for the job-eligibility workflow."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


def _present(value: Any) -> bool:
    return value is not None and value != "" and value != []


@dataclass
class EligibilitySessionState:
    profile: Dict[str, Any] = field(default_factory=dict)
    jobs_by_id: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    selected_job_ids: List[str] = field(default_factory=list)
    last_job_id: Optional[str] = None
    awaiting_field: Optional[str] = None

    def merge_metadata(self, metadata: Optional[Dict[str, Any]]) -> None:
        if not metadata:
            return

        for key, value in (metadata.get("profile") or {}).items():
            if _present(value) and not _present(self.profile.get(key)):
                self.profile[key] = value

        jobs = metadata.get("jobs") or []
        for index, job in enumerate(jobs):
            if not isinstance(job, dict):
                continue
            job_id = str(job.get("job_id") or job.get("_id") or f"job-{index + 1}")
            self.jobs_by_id[job_id] = {**job, "job_id": job_id}


_SESSIONS: Dict[str, EligibilitySessionState] = {}


def get_or_create_session(session_id: str) -> EligibilitySessionState:
    key = session_id or "default"
    if key not in _SESSIONS:
        _SESSIONS[key] = EligibilitySessionState()
    return _SESSIONS[key]


def clear_session(session_id: str) -> None:
    _SESSIONS.pop(session_id or "default", None)
