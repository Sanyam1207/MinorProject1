# Socket.io Relay — How It Works

Node's only job is routing: the frontend sends a query, Node opens a fresh
connection to the AI backend just for that query, streams the reply back to
the frontend, then closes it. It does not read, store, or transform anything.

- **Source:** `src/websocket/socket-server.js` (~50 lines)
- **URL (dev):** `http://localhost:8000`, default `/socket.io` path
- **Auth:** none

## The flow

```
Frontend                    Node (:8000)                    AI backend (:9000)
   |--- query {requestId, user_query} ------->|
   |                                           |--- opens a NEW connection --->|
   |                                           |--- query {requestId, user_query} -->|
   |                                           |<-- response {..., isEnd:false} -----|
   |<-- response --------------------------|                                   |
   |                                           |<-- response {..., isEnd:false} -----|
   |<-- response --------------------------|                                   |
   |                                           |<-- response {..., isEnd:true} ------|
   |<-- response (isEnd:true) --------------|                                   |
   |                                           |--- closes the connection --->|
```

One AI-backend connection per query, opened when the query starts, closed the
moment `isEnd: true` arrives. Not a persistent shared connection — every
message gets its own.

## Frontend → Node

Event `query`:

```json
{ "requestId": "<uuid, generated fresh per message>", "user_query": "build my resume" }
```

Generate a new `requestId` for every message you send — it's how Node knows
which reply belongs to which question. Don't reuse one across messages.

## Node → Frontend

Event `response`, one or more times per query, forwarded byte-for-byte from
the AI backend:

```json
{ "requestId": "same one you sent", "header_message": "resume-generator is responding", "response": "# Resume\n\n## Sky", "isEnd": false }
```

`response` is the **full markdown so far**, not a delta — render it directly
each time, no need to concatenate. The last event for a query has
`isEnd: true`; that's the finished answer.

If the AI backend is unreachable, Node still sends one `response` event with
`isEnd: true` and an explanatory `header_message`, so the frontend always
gets a terminal event either way.

## Testing without a browser

```bash
npm run dev                                    # terminal 1 — this backend
python -m app.main                             # terminal 2 — AI backend (see python-backend/)
node scripts/ui_test_client.mjs "build my resume"   # terminal 3
```

Terminal 3 prints every `response` chunk as it streams, then the full text
at the end.
