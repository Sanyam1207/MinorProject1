"""Per-chat job list ("the 2nd job") and last-viewed job, shared by agents.

The list holds the JobsListItems (JOB-FEED.md §12.5) currently on screen: a new
search REPLACES it, so "job 2" always means the 2nd card the user sees, in the
jobs-finder and in the copilot alike. Entries expire after
``JOBS_SESSION_TTL_SECONDS`` without use; at most ``JOBS_SESSION_MAX`` chats
are kept (least recently used evicted).
"""

from __future__ import annotations

import copy
import logging
import threading
from typing import Any, Dict, List, Optional

from app.config import settings
from app.utils.ttl_store import TTLStore

logger = logging.getLogger(__name__)


class SessionJobStore:
    """Thread-safe, size-capped job context keyed by session id."""

    def __init__(self) -> None:
        self._store: TTLStore[Dict[str, Any]] = TTLStore(
            "jobs-session",
            ttl_seconds=lambda: settings.JOBS_SESSION_TTL_SECONDS,
            max_items=lambda: settings.JOBS_SESSION_MAX,
        )
        self._lock = threading.Lock()

    def _entry(self, session_id: str) -> Dict[str, Any]:
        return self._store.get_or_create(session_id, lambda: {"jobs": [], "last_viewed": None})

    def replace_jobs(self, session_id: str, items: List[Dict[str, Any]]) -> None:
        """Replace the cached list with *items* (a new search result)."""
        if not session_id:
            return
        with self._lock:
            entry = self._entry(session_id)
            entry["jobs"] = [copy.deepcopy(item) for item in items if isinstance(item, dict)]

    # Backwards-compatible name: a new result set always replaces the old one.
    save_jobs = replace_jobs

    def update_job(self, session_id: str, job_id: str, **fields: Any) -> bool:
        """Update fields of the cached item with *job_id*; True when found."""
        if not session_id or not job_id:
            return False
        with self._lock:
            entry = self._store.get(session_id)
            if not entry:
                return False
            found = False
            for item in entry["jobs"]:
                if str(item.get("id")) == str(job_id):
                    item.update(fields)
                    found = True
            last = entry.get("last_viewed")
            if isinstance(last, dict) and str(last.get("id")) == str(job_id):
                last.update(fields)
            return found

    def get_jobs(self, session_id: str) -> List[Dict[str, Any]]:
        if not session_id:
            return []
        with self._lock:
            entry = self._store.get(session_id)
            return [copy.deepcopy(item) for item in entry["jobs"]] if entry else []

    def set_last_viewed_job(self, session_id: str, job: Dict[str, Any]) -> None:
        if not session_id or not isinstance(job, dict) or not job:
            return
        with self._lock:
            self._entry(session_id)["last_viewed"] = copy.deepcopy(job)

    def get_last_viewed_job(self, session_id: str) -> Optional[Dict[str, Any]]:
        if not session_id:
            return None
        with self._lock:
            entry = self._store.get(session_id)
            last = entry.get("last_viewed") if entry else None
            return copy.deepcopy(last) if isinstance(last, dict) else None

    def clear(self, session_id: Optional[str] = None) -> None:
        """Forget one chat's jobs (or every chat when *session_id* is None)."""
        with self._lock:
            if session_id is None:
                self._store.clear()
            else:
                self._store.pop(session_id)


# Global singleton instance
session_job_store = SessionJobStore()
