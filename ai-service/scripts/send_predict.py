"""Fire one query at the agent service and print the streamed response.

Usage:
    .venv/bin/python scripts/send_predict.py [requestId] ["the question"] [mode_name]

Environment (all optional):
    AI_URL            service URL (default http://127.0.0.1:$AI_PORT, port 9000)
    AI_SERVICE_TOKEN  sent as the socket auth token when set (must match the service)
    SEND_ROLE         user role to impersonate (default "student")
    TOOLS_URL, TOOL_TOKEN  Node agent-tools URL and a valid tool token, to let the
                      copilot call real tools (without them it answers that it is
                      not connected to the campus services)
"""

import asyncio
import json
import os
import sys
from datetime import datetime, timezone

import socketio

URL = os.getenv("AI_URL", f"http://127.0.0.1:{os.getenv('AI_PORT', '9000')}")


def build_payload(request_id: str, query: str, mode_name: str | None) -> dict:
    role = os.getenv("SEND_ROLE", "student")
    meta: dict = {
        "actor": {"user_id": "demo-user", "role": role, "name": "Demo User", "email": "demo.user@example.invalid"},
        "now": datetime.now(timezone.utc).isoformat(),
        "timezone": "Asia/Kolkata",
    }
    if os.getenv("TOOLS_URL") and os.getenv("TOOL_TOKEN"):
        meta["tools_url"] = os.environ["TOOLS_URL"]
        meta["tool_token"] = os.environ["TOOL_TOKEN"]
    return {
        "requestId": request_id,
        "sessionId": f"demo-user:{request_id}",
        "user_query": query,
        "user_role": "tpo" if role == "admin" else role,
        "mode_name": mode_name,
        "meta_data": meta,
    }


async def main() -> None:
    request_id = sys.argv[1] if len(sys.argv) > 1 else "req-1"
    query = sys.argv[2] if len(sys.argv) > 2 else "what can you do"
    mode_name = sys.argv[3] if len(sys.argv) > 3 else None
    token = os.getenv("AI_SERVICE_TOKEN")

    sio = socketio.AsyncClient()
    done = asyncio.Event()

    @sio.on("response")
    async def on_response(data: dict) -> None:
        print(f"<- {json.dumps(data, ensure_ascii=False)}")
        if data.get("isEnd"):
            done.set()

    await sio.connect(URL, auth={"token": token} if token else None, transports=["websocket"])
    await sio.emit("query", build_payload(request_id, query, mode_name))
    print(f"-> query requestId={request_id} user_query={query!r} mode_name={mode_name!r}")
    try:
        await asyncio.wait_for(done.wait(), timeout=130)
    finally:
        await sio.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
