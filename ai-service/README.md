# AI Backend — Socket layer

Python service that receives a query from the Node backend and streams the
answer straight back on that same connection.

```
Frontend --socket.io--> Node (:8000) --socket.io (one connection per query)--> this service (:9000)
                          ^                                                          |
                          +---------------- response streams back on it -------------+
```

Node opens a **new connection per query**, sends one `query` event, and
receives one or more `response` events back on that same connection. The
last one has `isEnd: true` -- Node closes the connection right after.

## Run

```bash
pip install -r requirements.txt
cp .env.example .env
python -m app.main         # listens on :9000
```

## Wire contract

**In** -- Node emits `query` on a fresh connection:

```json
{"requestId": "req-1", "user_query": "build my resume"}
```

**Out** -- this service emits `response` one or more times on that same
connection, ending with `isEnd: true`:

```json
{"requestId": "req-1", "header_message": "resume-generator is responding", "response": "# Resume\n\n## Sky", "isEnd": false}
{"requestId": "req-1", "header_message": "resume-generator is responding", "response": "# Resume\n\n## Skills...", "isEnd": false}
{"requestId": "req-1", "header_message": "resume-generator done",          "response": "# Resume\n\n## Skills...(full)", "isEnd": true}
```

`response` is the **full markdown so far**, not a delta -- render it
directly, no accumulation needed on the receiving end. `requestId` is
whatever Node sent; echo it back verbatim on every event.

## Layout

| File | Role |
|---|---|
| `app/main.py` | socket.io server -- `query` in, `response` out, `/health` |
| `app/orchestrator.py` | picks the agent, streams its output to the caller's `sid` |
| `app/agents/resume_generator.py` | dummy agent -- yields markdown deltas |
| `scripts/send_predict.py` | fire a test query, print the stream |

## Adding an agent

Yield markdown deltas, set `name`, register it:

```python
class JobsAgent:
    name = "jobs-finder"
    async def run(self, req):
        yield "## Matches\n"
```

Add it to `REGISTRY` in `app/agents/__init__.py` and to `route()` in
`app/orchestrator.py`. `route()` is a keyword stub today -- swap it for an
LLM call later, nothing downstream changes.

## Test without Node

```bash
python -m app.main                              # terminal 1 -- this service
python scripts/send_predict.py req-1 "build my resume"   # terminal 2
```

Terminal 2 prints every `response` event as it streams in.
