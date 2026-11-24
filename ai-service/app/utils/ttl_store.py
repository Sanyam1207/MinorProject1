"""A small in-memory key/value store with idle expiry and an LRU size cap.

Every per-session agent store uses it so a long-running service cannot grow
without bound: entries expire after ``ttl_seconds`` without access and, past
``max_items``, the least recently used entries are evicted. Both limits may be
callables so they are read from ``settings`` at call time.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import OrderedDict
from typing import Callable, Generic, Optional, Tuple, TypeVar, Union

V = TypeVar("V")

log = logging.getLogger("ttl_store")

Number = Union[int, float]


class TTLStore(Generic[V]):
    def __init__(
        self,
        name: str,
        *,
        ttl_seconds: Union[Callable[[], Number], Number],
        max_items: Union[Callable[[], int], int],
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.name = name
        self._ttl_source = ttl_seconds
        self._cap_source = max_items
        self._clock = clock
        self._data: "OrderedDict[str, Tuple[float, V]]" = OrderedDict()
        self._lock = threading.Lock()

    # -- configuration -------------------------------------------------------

    def _ttl(self) -> float:
        value = self._ttl_source() if callable(self._ttl_source) else self._ttl_source
        try:
            return max(0.0, float(value))
        except (TypeError, ValueError):
            return 0.0

    def _cap(self) -> int:
        value = self._cap_source() if callable(self._cap_source) else self._cap_source
        try:
            return max(1, int(value))
        except (TypeError, ValueError):
            return 1

    @staticmethod
    def _key(key: Optional[str]) -> str:
        return str(key) if key else "default"

    # -- internals (lock held) -----------------------------------------------

    def _prune_locked(self, now: float) -> int:
        removed = 0
        ttl = self._ttl()
        # Entries are kept in access order, so expired ones sit at the front.
        while self._data:
            oldest_key, (last_access, _) = next(iter(self._data.items()))
            if now - last_access > ttl:
                del self._data[oldest_key]
                removed += 1
            else:
                break
        cap = self._cap()
        while len(self._data) > cap:
            self._data.popitem(last=False)
            removed += 1
        if removed:
            log.info("%s store evicted %d entr%s", self.name, removed, "y" if removed == 1 else "ies")
        return removed

    def _get_locked(self, key: str, now: float) -> Optional[V]:
        entry = self._data.get(key)
        if entry is None:
            return None
        last_access, value = entry
        if now - last_access > self._ttl():
            del self._data[key]
            return None
        self._data[key] = (now, value)
        self._data.move_to_end(key)
        return value

    # -- public API ----------------------------------------------------------

    def get(self, key: Optional[str]) -> Optional[V]:
        """The value, or None when absent/expired. Refreshes recency."""
        k = self._key(key)
        with self._lock:
            now = self._clock()
            self._prune_locked(now)
            return self._get_locked(k, now)

    def get_or_create(self, key: Optional[str], factory: Callable[[], V]) -> V:
        k = self._key(key)
        with self._lock:
            now = self._clock()
            self._prune_locked(now)
            value = self._get_locked(k, now)
            if value is None:
                value = factory()
                self._data[k] = (now, value)
                self._data.move_to_end(k)
                self._prune_locked(now)
            return value

    def set(self, key: Optional[str], value: V) -> None:
        k = self._key(key)
        with self._lock:
            now = self._clock()
            self._data[k] = (now, value)
            self._data.move_to_end(k)
            self._prune_locked(now)

    def pop(self, key: Optional[str], default: Optional[V] = None) -> Optional[V]:
        k = self._key(key)
        with self._lock:
            entry = self._data.pop(k, None)
            if entry is None:
                return default
            last_access, value = entry
            if self._clock() - last_access > self._ttl():
                return default
            return value

    def __contains__(self, key: object) -> bool:
        k = self._key(key if isinstance(key, str) else (str(key) if key else None))
        with self._lock:
            entry = self._data.get(k)
            if entry is None:
                return False
            return self._clock() - entry[0] <= self._ttl()

    def __len__(self) -> int:
        with self._lock:
            self._prune_locked(self._clock())
            return len(self._data)

    def prune(self) -> int:
        """Drop expired entries, then LRU entries above the cap. Returns the count removed."""
        with self._lock:
            return self._prune_locked(self._clock())

    def clear(self) -> None:
        with self._lock:
            self._data.clear()
