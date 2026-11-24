"""Fire a query at this backend and print the streamed response.

Usage: python scripts/send_predict.py [requestId] ["the question"]
"""

import asyncio
import sys

import socketio

URL = "http://localhost:9000"


async def main() -> None:
    rid = sys.argv[1] if len(sys.argv) > 1 else "req-1"
    query = sys.argv[2] if len(sys.argv) > 2 else "build my resume"

    sio = socketio.AsyncClient()
    done = asyncio.Event()

    @sio.on("response")
    async def on_response(data: dict) -> None:
        print(f"<- {data}")
        if data.get("isEnd"):
            done.set()

    await sio.connect(URL)
    await sio.emit("query", {
        "requestId": rid, 
        "sessionId": rid, 
        "user_query": query,
        "mode_name": "resume-generator",
        "meta_data": {
            "name": "Bruce Wayne",
            "email": "bruce@wayne-enterprises.com",
            "college": "Gotham University",
            "degree": "Bachelor of Science in Computer Science",
            "graduation_year": "2024",
            "cgpa": "3.8",
            "tenth_percentage": "95",
            "twelfth_percentage": "92",
        }
    })

    print(f"-> query requestId={rid} user_query={query!r}")

    await done.wait()
    await sio.disconnect()


asyncio.run(main())
