"""AI backend entrypoint.

Node opens a fresh Socket.IO connection here for every query, sends one
`query` event, and gets one or more `response` events back on that same
connection -- the last one has isEnd=true, and Node closes the connection.
"""

import asyncio
import logging

import socketio
import uvicorn
from fastapi import FastAPI
from pydantic import ValidationError

from app.config import settings
from app.orchestrator import handle
from app.schemas import QueryRequest

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s  %(levelname)-7s %(name)s  %(message)s"
)
log = logging.getLogger("ai-backend")

api = FastAPI(title="AI Backend")


@api.get("/health")
async def health() -> dict:
    return {"ok": True}


sio = socketio.AsyncServer(async_mode="asgi", cors_allowed_origins="*")


@sio.event
async def connect(sid: str, _environ: dict) -> None:
    log.info("node connected: %s", sid)


@sio.event
async def disconnect(sid: str) -> None:
    log.info("node disconnected: %s", sid)


# Strong references to the in-flight query tasks. asyncio only holds a weak
# reference to a running task, so a bare create_task() can be garbage collected
# mid-flight -- and the caller would then wait forever for an isEnd that never
# arrives. Discarded again as each task finishes.
_INFLIGHT: set[asyncio.Task] = set()


def _task_done(task: asyncio.Task) -> None:
    _INFLIGHT.discard(task)
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
        log.warning("bad query payload from %s: %s", sid, exc)
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

    task = asyncio.create_task(handle(req, sio, sid))
    _INFLIGHT.add(task)
    task.add_done_callback(_task_done)


app = socketio.ASGIApp(sio, other_asgi_app=api)


if __name__ == "__main__":
    uvicorn.run(app, host=settings.AI_HOST, port=settings.AI_PORT)
