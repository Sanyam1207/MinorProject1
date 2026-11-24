"""Per-chat state for the job-eligibility workflow.

Trust model (PYTHON.md §6.3): the profile Node sends in ``meta_data.profile``
comes from the college database and is authoritative. It REPLACES
``trusted_profile`` on every turn (fresh metadata wins). Values the user types
are kept apart: ``self_reported`` fills gaps the record does not cover, and
``what_if`` holds typed values that contradict the record -- they produce a
clearly labelled hypothetical result, never the official verdict.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from app.config import settings
from app.utils.ttl_store import TTLStore


def _present(value: Any) -> bool:
    return value is not None and value != "" and value != []


@dataclass
class EligibilitySessionState:
    trusted_profile: Dict[str, Any] = field(default_factory=dict)
    self_reported: Dict[str, Any] = field(default_factory=dict)
    what_if: Dict[str, Any] = field(default_factory=dict)
    jobs_by_id: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    selected_job_ids: List[str] = field(default_factory=list)
    last_job_id: Optional[str] = None
    awaiting_field: Optional[str] = None
    # The caller's role. For a student the record wins over typed values; for
    # staff checking a hypothetical student, the typed values are the subject.
    role: str = "student"

    @property
    def profile(self) -> Dict[str, Any]:
        """The profile the official checks run on."""
        if self.role != "student":
            return {**self.trusted_profile, **self.self_reported}
        return {**self.self_reported, **self.trusted_profile}

    def merge_metadata(self, metadata: Optional[Dict[str, Any]]) -> None:
        if not isinstance(metadata, dict):
            return
        profile = metadata.get("profile")
        if isinstance(profile, dict) and profile:
            self.trusted_profile = {key: value for key, value in profile.items() if _present(value)}

        jobs = metadata.get("jobs")
        if isinstance(jobs, list):
            replaced: Dict[str, Dict[str, Any]] = {}
            for index, job in enumerate(jobs):
                if not isinstance(job, dict):
                    continue
                job_id = str(job.get("job_id") or job.get("_id") or job.get("id") or f"job-{index + 1}")
                replaced[job_id] = {**job, "job_id": job_id}
            self.jobs_by_id = replaced
            self.selected_job_ids = [job_id for job_id in self.selected_job_ids if job_id in replaced]
            if self.last_job_id not in replaced:
                self.last_job_id = None


_SESSIONS: TTLStore[EligibilitySessionState] = TTLStore(
    "eligibility",
    ttl_seconds=lambda: settings.AGENT_SESSION_TTL_SECONDS,
    max_items=lambda: settings.AGENT_MAX_SESSIONS,
)


def get_or_create_session(session_id: str) -> EligibilitySessionState:
    return _SESSIONS.get_or_create(session_id or "default", EligibilitySessionState)


def clear_session(session_id: str) -> None:
    _SESSIONS.pop(session_id or "default", None)
