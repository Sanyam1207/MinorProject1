"""Agent service entrypoint.

Node opens a fresh Socket.IO connection here for every query (sending
``auth: {token: AI_SERVICE_TOKEN}``), emits one ``query`` event and receives
one or more ``response`` events on that same connection -- the last one has
``isEnd: true`` and Node closes the connection.

Security: when ``AI_SERVICE_TOKEN`` is set every connection must present it;
the service binds to loopback by default; browser origins are refused unless
listed in ``AI_CORS_ORIGINS``. Disconnecting cancels the connection's work.
"""

from app.logging_setup import configure_logging

configure_logging()

import asyncio  # noqa: E402
import hmac  # noqa: E402
import logging  # noqa: E402
from typing import Dict, Optional, Set  # noqa: E402

import socketio  # noqa: E402
import uvicorn  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from pydantic import ValidationError  # noqa: E402

from app.config import settings  # noqa: E402
from app.orchestrator import handle  # noqa: E402
from app.schemas import QueryRequest  # noqa: E402

log = logging.getLogger("ai-backend")

MAX_HTTP_BUFFER_SIZE = 10_000_000  # meta_data can carry job lists; default 1 MB drops the connection

api = FastAPI(title="Matchy Campus AI service", docs_url=None, redoc_url=None, openapi_url=None)


@api.get("/health")
async def health() -> dict:
    return {"ok": True}


sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins=settings.cors_allowed_origins(),
    max_http_buffer_size=MAX_HTTP_BUFFER_SIZE,
)

# Strong references to in-flight query tasks (asyncio keeps only weak ones),
# plus the tasks of each connection so a disconnect can cancel them.
_INFLIGHT: Set[asyncio.Task] = set()
_TASKS_BY_SID: Dict[str, Set[asyncio.Task]] = {}


def _token_ok(auth: object) -> bool:
    expected = settings.AI_SERVICE_TOKEN
    if not expected:
        return True
    if not isinstance(auth, dict):
        return False
    supplied = str(auth.get("token") or "")
    return hmac.compare_digest(supplied.encode("utf-8"), expected.encode("utf-8"))


@sio.event
async def connect(sid: str, environ: dict, auth: Optional[dict] = None) -> None:
    if not _token_ok(auth):
        log.warning("rejected unauthenticated connection %s", sid)
        raise socketio.exceptions.ConnectionRefusedError("unauthorized")
    log.info("node connected: %s", sid)


@sio.event
async def disconnect(sid: str, reason: Optional[object] = None) -> None:
    tasks = _TASKS_BY_SID.pop(sid, set())
    cancelled = 0
    for task in tasks:
        if not task.done():
            task.cancel()
            cancelled += 1
    if cancelled:
        log.info("node disconnected: %s (cancelled %d in-flight task(s))", sid, cancelled)
    else:
        log.info("node disconnected: %s", sid)


def _forget(task: asyncio.Task, sid: str) -> None:
    _INFLIGHT.discard(task)
    tasks = _TASKS_BY_SID.get(sid)
    if tasks is not None:
        tasks.discard(task)
        if not tasks:
            _TASKS_BY_SID.pop(sid, None)
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        log.error("query task failed: %r", exc, exc_info=exc)


@sio.on("query")
async def on_query(sid: str, data: object) -> None:
    # Node always sends an object, but anything can arrive over a socket; a
    # non-dict must still get an answer rather than leaving the caller hanging.
    payload = data if isinstance(data, dict) else {}
    try:
        req = QueryRequest(**payload)
    except (ValidationError, TypeError) as exc:
        log.warning("bad query payload from %s: %s", sid, type(exc).__name__)
        await sio.emit(
            "response",
            {
                "requestId": payload.get("requestId"),
                "header_message": "invalid request",
                "response": "",
                "isEnd": True,
            },
            to=sid,
        )
        return

    task = asyncio.create_task(handle(req, sio, sid), name=f"query:{req.requestId}")
    _INFLIGHT.add(task)
    _TASKS_BY_SID.setdefault(sid, set()).add(task)
    task.add_done_callback(lambda done, _sid=sid: _forget(done, _sid))


app = socketio.ASGIApp(sio, other_asgi_app=api)


def _is_loopback(host: str) -> bool:
    return host.strip().lower() in ("127.0.0.1", "::1", "localhost")


if __name__ == "__main__":
    configure_logging()
    if not settings.AI_SERVICE_TOKEN:
        level = logging.WARNING if _is_loopback(settings.AI_HOST) else logging.ERROR
        log.log(level, "AI_SERVICE_TOKEN is empty: socket connections are unauthenticated")
    uvicorn.run(
        app,
        host=settings.AI_HOST,
        port=settings.AI_PORT,
        log_level=settings.LOG_LEVEL.lower(),
        server_header=False,
        # Keep uvicorn's loggers on the root handler so its lines are redacted too.
        log_config=None,
    )
