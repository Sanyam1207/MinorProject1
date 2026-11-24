import logging
from typing import Dict, List, Any
from threading import Lock

logger = logging.getLogger(__name__)


class SessionJobStore:
    """In-memory thread-safe storage for scraped job listings and last-viewed job context keyed by session ID."""

    def __init__(self):
        self._store: Dict[str, List[Dict[str, Any]]] = {}
        self._last_viewed: Dict[str, Dict[str, Any]] = {}
        self._lock = Lock()

    def save_jobs(self, session_id: str, jobs: List[Dict[str, Any]]) -> None:
        """Store or update jobs for a session ID."""
        if not session_id:
            return
        with self._lock:
            if session_id not in self._store:
                self._store[session_id] = []
            
            # Deduplicate by title + company + application_url
            existing_keys = {
                (
                    j.get("title", "").lower(),
                    j.get("company", j.get("company_name", "")).lower(),
                    j.get("application_url", "").lower()
                )
                for j in self._store[session_id]
            }

            for job in jobs:
                key = (
                    job.get("title", "").lower(),
                    job.get("company", job.get("company_name", "")).lower(),
                    job.get("application_url", "").lower()
                )
                if key not in existing_keys:
                    self._store[session_id].append(job)
                    existing_keys.add(key)

    def get_jobs(self, session_id: str) -> List[Dict[str, Any]]:
        """Retrieve stored jobs for a session ID."""
        if not session_id:
            return []
        with self._lock:
            return list(self._store.get(session_id, []))

    def set_last_viewed_job(self, session_id: str, job: Dict[str, Any]) -> None:
        """Track the most recently detailed/elaborated job for a session ID."""
        if not session_id or not job:
            return
        with self._lock:
            self._last_viewed[session_id] = job

    def get_last_viewed_job(self, session_id: str) -> Dict[str, Any] | None:
        """Retrieve the most recently detailed/elaborated job for a session ID."""
        if not session_id:
            return None
        with self._lock:
            return self._last_viewed.get(session_id)

    def clear(self, session_id: str) -> None:
        """Clear cached jobs and last-viewed job for a session ID."""
        with self._lock:
            self._store.pop(session_id, None)
            self._last_viewed.pop(session_id, None)


# Global singleton instance
session_job_store = SessionJobStore()
