# Matchy Campus — AI agent service

Python service behind the left-hand chat. The Node backend opens one Socket.IO connection per query,
emits one `query`, and receives one or more `response` events on the same connection; the last one has
`isEnd: true`. Specialised agents keep their own flows; everything else — attendance, applications, offers,
training, notifications, the job feed, resume scoring/tailoring — is handled by the **copilot**, a
Gemini function-calling agent whose tools execute inside Node **as the logged-in user** and whose results
update the right-hand workspace through `ui_actions`.

```
Browser ──socket──▶ Node ──socket.io (one connection per query, auth {token})──▶ this service (127.0.0.1:9000)
                      ▲                                                             │ copilot tool calls
                      └──── response chunks (…, isEnd: true) ◀──────────────────────┤
                      Node /api/v1/agent-tools/{manifest,execute} ◀── Bearer tool_token ┘
```

Contracts: [`docs/contracts/PYTHON.md`](../docs/contracts/PYTHON.md) (this service),
[`AGENT-TOOLS.md` §6](../docs/contracts/AGENT-TOOLS.md) (copilot wire format),
[`UI-ACTIONS.md`](../docs/contracts/UI-ACTIONS.md) (panel ids), [`JOB-FEED.md` §12](../docs/contracts/JOB-FEED.md) (jobs-finder).

## Setup

```bash
cd ai-service
python3.14 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
cp .env.example .env          # then fill in GEMINI_API_KEY and AI_SERVICE_TOKEN
```

Playwright is an optional crawler fallback (`.venv/bin/python -m playwright install chromium`); without
browsers the crawler uses static HTML.

## Run

```bash
.venv/bin/python -m app.main                  # listens on AI_HOST:AI_PORT (default 127.0.0.1:9000)
.venv/bin/python scripts/send_predict.py r1 "what can you do"            # one query, prints the stream
SEND_ROLE=teacher .venv/bin/python scripts/send_predict.py r2 "schedule DBMS tomorrow 10am" copilot
```

`AI_SERVICE_TOKEN` must equal the backend's `AI_SERVICE_TOKEN`; the scripts send it from the environment.
Without `GEMINI_API_KEY` every agent takes its deterministic fallback (the copilot uses its offline planner).

## Tests

```bash
.venv/bin/python -m pytest -q
```

No network and no `.env` are needed: `tests/conftest.py` pins the environment before importing `app`,
blocks real HTTP for both clients, and the Node tools and the LLM are faked (`tests/fakes.py`).

## Wire contract (summary)

In (`query`): `{requestId, sessionId: "<userId>:<browserSessionId>", user_query, user_role?, mode_name?,
past_messages?, meta_data?, mail_draft?, alumni_request_draft?, resume_share_draft?}`. `meta_data` carries
`actor {user_id, role, name, email}`, `tool_token`, `tools_url`, `now`, `timezone`, optional `ui_context
{panel, mode, params}`, `selected_job`, `profile`, and per-agent keys.

Out (`response`): `{requestId, sessionId?, header_message, response, data, isEnd, options?, confidence_score?}`.
`response` is always the complete markdown so far. **Exactly one** payload per query has `isEnd: true` and it
is the last one — whatever fails (the orchestrator emits `copilot:error` if an agent or the router raises).
A query cancelled by a disconnect emits nothing more.

Copilot chunks (`data.type == "copilot"`, cumulative `tool_calls` and `ui_actions`):

| header | isEnd | notes |
|---|---|---|
| `copilot:thinking` | false | `_Thinking…_` |
| `copilot:tool` | false | one progress line per tool call; new `ui_actions` appear here first |
| `copilot:answer` | true | final markdown; `options` = candidate labels after an AMBIGUOUS result |
| `copilot:confirm` | true | `data.pending {tool, args, preview}`, `options ["Confirm", "Cancel"]` |
| `copilot:error` | true | `data.message` |

`tool_calls[i] = {id: "tc<n>", name, args, status: running|done|error|needs_confirmation, summary?, error?}`;
`ui_actions[i] = {id: "tc<n>:<k>", panel, params, data?}`. A "Confirm" reply re-executes the stored,
server-normalised arguments with `confirmed: true` (never an LLM-controlled argument); "Cancel" drops it.

## Agents and routing

| mode | agent | roles |
|---|---|---|
| `copilot` | tool-calling campus assistant (attendance, applications, offers, training, notifications, job feed, resumes); the fallback | all |
| `jobs-finder` | real job search (campus drives + open-market feed via Node tools), careers-page crawl, job tracker | student, tpo, admin |
| `job-eligibility` | deterministic eligibility checks (the profile on record wins; typed values give a labelled what-if) | student, tpo, admin |
| `resume-generator` | conversational LaTeX resume builder, ATS score, gap analysis | student |
| `ai-interviewer` | time-boxed mock interview + report | student |
| `learning-recommendation` | readable study plan from a past interview | student |
| `pr-outreach` | outreach email drafting | student, tpo, admin |
| `alumni-connect` | alumni mentor matching and requests | student |
| `job-creation` | post a campus job by chat (explicit "yes" required) | tpo, admin |
| `gap-analysis` | curriculum gap analysis | tpo, admin |

Teachers, recruiters and alumni use the copilot only; attendance is never a separate mode. Routing is
deterministic (each agent's `ROUTING_RULES`, filtered by role in `app/agents/roles.py`); ties, no match, or a
request owned by an agent the role may not use go to the copilot (no `mode:none`).

## Layout

| path | role |
|---|---|
| `app/main.py` | Socket.IO server: auth, `query` → task, disconnect cancels, `/health` |
| `app/orchestrator.py` | role-aware router, `RouteDecision`, `ChunkEmitter`, guarded `handle()` |
| `app/agents/roles.py`, `confirm.py`, `modes.py`, `routing.py` | role matrix, yes/no classifier, modes, routing rules |
| `app/agents/copilot/` | copilot: agent, LLM loop, prompt, offline planner, tools client, session store |
| `app/llm/gemini.py` | the one Gemini REST client (key in `x-goog-api-key` only, retries, SSE) |
| `app/tools_client.py` | Node agent-tool API client (`execute_tool`, `fetch_manifest`) |
| `app/utils/ttl_store.py` | TTL + LRU-capped in-memory store used by every agent session store |
| `app/agents/*` | the specialised agents |

## Security notes

- The Gemini key is sent only in the `x-goog-api-key` header — never in a URL — and httpx/httpcore request
  logging is kept at WARNING. A log filter masks the key, the service token, `key=` query values and bearer tokens.
- Socket connections must present `auth.token == AI_SERVICE_TOKEN` when it is set; the default bind is loopback;
  browser origins are refused unless listed in `AI_CORS_ORIGINS`.
- Tool calls run in Node as the user (short-lived tool token); Node re-authorizes every call. Side effects
  always need the user's explicit confirmation.
- State is in memory, keyed by the user-namespaced session id, with idle TTLs and size caps. Run a single
  worker process (state is not shared between processes).
