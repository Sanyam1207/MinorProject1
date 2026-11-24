# Job feed — operations guide

The open-market job feed collects jobs from external job boards (and, optionally, WhatsApp job
channels) into MongoDB. Students search it, rank it by fit with their profile, and track the jobs
they save or apply to. It is the Matchy job aggregation, ported into Matchy Campus as the
`job-feed` backend module (`backend/src/modules/job-feed/`). The contract is
[`docs/contracts/JOB-FEED.md`](contracts/JOB-FEED.md).

Vocabulary: a **campus drive** is a placement-cell job (`jobs` collection, placements module).
An **external job** is a feed job (`external_jobs` collection, this module). They never share a
model, a collection or an id space.

## How it works

1. A **sync** asks each polled source for its jobs, page by page.
2. Every job is cleaned into one shape and gets a `dedupeKey`. MongoDB allows one job per key.
3. A job seen again keeps its first details, gains the new source in `sources`, its `postedAt`
   moves forward (a repost bubbles up), `lastSeenAt` is updated, and fields it was missing (for
   example a description) are filled from the later source. Stored values are never overwritten.
4. The API and the website read MongoDB only. No request ever calls a source.

## Sources

| Name | Label | Kind | Enabled when | Notes |
| --- | --- | --- | --- | --- |
| `debugwithshubham` | DebugWithShubham | poll | always | `GET https://debugwithshubham-web-page.onrender.com/api/jobs/` — FullTime, Internship and Contract, 200 per page, up to 25 pages each. Hosted on Render: the first request after idling can take up to a minute (60 s timeout). Times are Indian wall-clock times. No descriptions or categories. Third-party feed, no SLA. |
| `artha` | artha.link | poll | `FROM_ARTHA=true` | Undocumented artha.link job-board API (`POST https://artha.link/api/job-api/recommend`). One search per keyword (`ARTHA_KEYWORDS`, else 25 built-in keywords), 100 per page, up to 20 pages, 30 s timeout. HTML descriptions become plain text; the apply link is the job's public artha.link page. It may break without notice. |
| `whatsapp` | WhatsApp | push | `WHATSAPP_ENABLED=true` in the API, or `npm run whatsapp` | Posts from WhatsApp channels you follow. Off by default; see [WhatsApp channels](#whatsapp-channels). |
| `sample` | Sample | seed | demo seed only | 16 fictional listings (`example.com` links) so the feed is not empty during an offline demo. |

No source needs credentials or API keys.

## When jobs are fetched

- **Every `JOB_SYNC_INTERVAL_MINUTES` minutes** (default 60) by the in-process scheduler
  (`core/scheduler.js`, job `job-feed:sync`). `0` turns the periodic sync off.
- **Once on boot, but only when it is stale.** Five seconds after the server starts, the boot sync
  runs only if the last successful sync (`ok` or `partial`) started longer ago than the interval
  (60 min when the interval is 0), and not within 10 minutes of a failed attempt. Restarting the
  dev server (`nodemon`, `--watch`) therefore does not hit the third-party feeds again.
  `JOB_SYNC_ON_BOOT=false` skips it entirely.
- **On demand**: the TPO panel's SYNC NOW button, the copilot tool `job_feed_sync` (asks for
  confirmation), or `POST /api/v1/job-feed/sync` (TPO/admin token, or the cron secret below).

Only one sync runs at a time. A request that arrives while a sync is running shares that run.
Runs are stored in `job_sync_runs` for 30 days; a run left `running` by a crash or restart is
marked `failed` ("Interrupted by a server restart") when the server starts.

### Cron (external scheduler)

Set `ADMIN_SYNC_SECRET` in `backend/.env` (never ship it to the frontend), then:

```bash
curl -X POST -H "x-admin-sync-secret: $ADMIN_SYNC_SECRET" "$API/api/v1/job-feed/sync?wait=true"
```

Without `?wait=true` the endpoint answers `202 {run, alreadyRunning}` at once and the run continues
in the background. A missing/wrong secret, or an empty `ADMIN_SYNC_SECRET`, answers
`401 INVALID_SYNC_SECRET`. At most 3 sync requests per minute per caller.

Example crontab line (hourly, with the in-process schedule turned off by `JOB_SYNC_INTERVAL_MINUTES=0`):

```cron
0 * * * * curl -fsS -X POST -H "x-admin-sync-secret: $ADMIN_SYNC_SECRET" "https://api.example.edu/api/v1/job-feed/sync?wait=true" > /dev/null
```

## When a source is down (offline behaviour)

- A failing source is recorded with its error, the batches it already saved are kept, and the next
  source still runs (`partial`).
- If every source fails (no network, DNS error, upstream down) the run ends `failed`; nothing is
  deleted or modified, sample listings stay, the run is stored with each source's error, and the
  next scheduled tick retries. The API keeps serving the stored jobs.
- The first failed run of a day (after a run that did not fail) notifies every TPO and admin
  (`jobfeed.sync.failed`, opens the Job feed panel).

`GET /api/v1/job-feed/sync/status` (TPO/admin) shows the running run, the last runs, the schedule,
per-source counts and last errors, the WhatsApp listener state and totals.

## Duplicates

The apply link is the best clue. Matchy Campus ignores `www.`, `http` vs `https`, a trailing `/` or
`?`, and tracking parameters (`utm_*`, `gh_src`, `ref`, `src`, …).

1. **The link contains a job id** (`99497774528`, `R165379`, …): the link alone identifies the job.
2. **The link is a generic careers page or a short link** (`careers.swiggy.com`, `bit.ly/…`): the
   company and title must also match.
3. **No link**: company and title must match (`LLC`, `Ltd`, `Pvt` … are ignored).
4. **No link and no company**: the job only matches itself (same source and id).

The unique index on `dedupeKey` guarantees one document per job even under concurrent syncs.
Known limits: a source that attaches another company's link merges two jobs; the same job with two
unrelated links (LinkedIn and the company site) is stored twice.

## Retention and sample listings

- **Retention**: once a day (`job-feed:purge`) jobs that no source has reported for
  `JOB_FEED_RETENTION_DAYS` days (default 45) are deleted, except sample listings and jobs a student
  has in their tracker. `0` disables the purge. Tracker entries keep a snapshot, so a purged job
  still shows in the student's tracker as "no longer available".
- **Sample listings**: the demo seed (`npm run seed:demo`) calls `seedSampleExternalJobs()` from
  `backend/src/modules/job-feed/sample-jobs.js` (idempotent; re-seeding refreshes their dates).
  They are marked `isSample` and shown with a "Sample listing" badge. After the first successful
  sync that finds real jobs, every sample nobody saved is removed automatically; a failed (offline)
  run never removes them. `removeSampleJobs()` deletes them all (demo wipe).

## Student tracker and notifications

- Students save open-market jobs and move them through `saved → applied → interviewing → offer /
  rejected` (`/api/v1/job-feed/saved`, or the copilot tools `market_job_save` and
  `market_job_mark_applied`). Campus drives are tracked by the placements module's applications.
- After a sync that inserted real jobs, each student whose profile (skills, project skills,
  preferred roles) fits at least one new job with a score of 60 or more gets one
  `jobfeed.matches` notification per day (`JOB_FEED_MATCH_DIGEST=false` turns it off).
- Socket events: `job-feed:sync` `{run}` to TPO/admin rooms when a run starts and finishes;
  `job-feed:updated` `{inserted, source, at}` to students, TPOs and admins when new jobs arrive.

## Settings (`backend/.env`)

| Variable | Default | What it does |
| --- | --- | --- |
| `JOB_SYNC_INTERVAL_MINUTES` | `60` | Periodic sync interval, 0–10080. `0` turns the periodic sync off. Invalid values mean 60. |
| `JOB_SYNC_ON_BOOT` | `true` | `false` skips the (stale-only) boot sync. |
| `ADMIN_SYNC_SECRET` | empty | Lets a cron job call `POST /api/v1/job-feed/sync` with the `x-admin-sync-secret` header. Empty disables the header. |
| `FROM_ARTHA` | `false` | `true` adds the artha.link source. |
| `ARTHA_KEYWORDS` | empty | Comma list of artha searches/categories, e.g. `developer,data-analyst`. Empty uses the 25 built-in keywords. |
| `ARTHA_LOCATION` | `IN` | Country the artha API searches. |
| `ARTHA_COUNTRIES` | empty | Comma list of country codes to keep, e.g. `IN`. Empty keeps every job (the API returns many remote US contract jobs). |
| `JOB_FEED_RETENTION_DAYS` | `45` | Delete jobs not seen for this many days (0–3650; `0` disables). |
| `JOB_FEED_MATCH_DIGEST` | `true` | `false` disables the daily `jobfeed.matches` notification. |
| `WHATSAPP_ENABLED` | `false` | `true` runs the WhatsApp listener inside the API. |
| `WHATSAPP_CHANNELS` | empty | Channel links, invite codes, `<digits>@newsletter` ids, or `all`. |
| `WHATSAPP_LLM_EMAIL` | empty | TPO/admin account whose saved LLM key reads the posts. Empty → the only TPO/admin with a key. |
| `WHATSAPP_LLM_PROVIDER` | empty | `openai`, `anthropic`, `google` or `xai` when that account has several keys. |
| `WHATSAPP_LLM_MODEL` | empty | Model to use instead of the one saved with the key. |
| `WHATSAPP_PAIRING_NUMBER` | empty | Link with an 8-character pairing code instead of the terminal QR. |

Also used: `TOKEN_ENCRYPTION_KEY` (64 hex chars; encrypts the WhatsApp login),
`LLM_CREDENTIAL_ENCRYPTION_KEY` (BYOK keys), `APP_TIMEZONE` (dates in summaries and the daily
notification keys).

Collections: `external_jobs`, `saved_jobs`, `job_sync_runs` (30-day TTL), `whatsapp_posts`
(30-day TTL), `whatsapp_auth_state`.

## WhatsApp channels

Optional and **off by default**. The listener links to a WhatsApp account the way WhatsApp Web does
(a "linked device"), reads new posts from the channels you choose, and turns job posts into feed
jobs with the source `whatsapp`.

### Requirements

- The optional npm package `baileys` (in `optionalDependencies`). Without it
  (`npm install --omit=optional`) the API runs normally and the listener reports
  `unavailable`: *The optional "baileys" package is not installed, so WhatsApp channels are off.*
  Nothing loads `baileys` unless the listener starts.
- `TOKEN_ENCRYPTION_KEY` (64 hex characters). The login is stored encrypted in
  `whatsapp_auth_state`; without a valid key the listener reports `unavailable`.

### Use a spare number

WhatsApp does not allow unofficial clients, and using one can get a number banned. Only reading
channels at low volume is lower risk than sending messages, but it is not risk-free. Channels are
public, so follow them from a **spare number** and link that number, not a personal one. The
listener never sends messages, never sends read receipts and stays "offline", so notifications keep
working on the phone.

### Set it up

1. **Choose the channels** in `backend/.env`, comma-separated:
   ```env
   WHATSAPP_CHANNELS=https://whatsapp.com/channel/0029Va...,https://whatsapp.com/channel/0029Vb...
   ```
   To get a link, open the channel in WhatsApp, tap its name, then **Share** / **Copy link**. You
   can leave it empty the first time: the listener prints the id (`…@newsletter`) of every channel
   that posts, which you can copy into `WHATSAPP_CHANNELS`. `all` reads every channel you follow.
2. **Choose how posts are read (recommended).** A TPO or admin account saves an LLM key with the
   BYOK API (`PUT /api/v1/llm/credentials/<provider>` with `{apiKey, model?}`, any role; see
   [RESUME-BYOK.md §9](contracts/RESUME-BYOK.md)). If several TPO/admin accounts have keys, set
   `WHATSAPP_LLM_EMAIL`. A student's key is never used. Without a key the listener uses simple rules
   that understand posts such as `Role: SDE-1` and `Apply: https://…`. The key is loaded when the
   listener starts, so restart it after saving a key.
3. **Link the phone** with the standalone worker:
   ```bash
   cd backend
   npm run whatsapp          # node scripts/job-feed-whatsapp.js
   ```
   On the phone: WhatsApp → **Settings → Linked devices → Link a device**, and scan the QR code shown
   in the terminal. If scanning is awkward, set `WHATSAPP_PAIRING_NUMBER` to the number with its
   country code (e.g. `919876543210`); the terminal then shows an 8-character code to enter under
   **Link with phone number instead**.
4. **Keep it running**, either:
   - standalone: keep `npm run whatsapp` running next to the API (same database), or
   - inside the API: stop the worker (Ctrl+C) and set `WHATSAPP_ENABLED=true`, then restart the API.
     Because the login lives in MongoDB, a device linked from a laptop works for the deployed API
     as long as both use the same database and the same `TOKEN_ENCRYPTION_KEY`.

**Run only one listener per login** (in-API or standalone, never both): WhatsApp disconnects one of
them ("Another listener connected with the same WhatsApp login").

### What happens to a post

- Only posts from the chosen channels, at most 3 days old, are read. Personal chats and groups are
  ignored.
- Posts without job words, or without a link or email to apply, are recorded as `ignored`.
- Short links (`bit.ly`, `lnkd.in`, …) are followed to the real job page (max 5 hops, 8 s); job
  sites themselves are never requested.
- The LLM (or the rules) extracts one entry per opening; an apply link must appear in the post.
- Jobs go through the same cleaning and duplicate rules as every other source; a job already in
  the feed gains `whatsapp` in its sources. The post text becomes the job's description.
- Every post is recorded in `whatsapp_posts` as `saved`, `ignored` (`reason`) or `failed` (`error`).
  A handled post is never sent to the LLM twice.
- Temporary LLM errors (rate limits, overloads, network) are retried after 5 s and 20 s. Failed
  posts from the last 3 days are retried when the listener starts and every 15 minutes (up to 5
  attempts).
- New jobs emit `job-feed:updated` (in-API listener only; the standalone worker has no sockets).

### Troubleshooting

| Message | What to do |
| --- | --- |
| `WhatsApp logged this device out` | The saved login was removed automatically. Run `npm run whatsapp` (or restart the API) and link again. |
| `Another listener connected with the same WhatsApp login` | Run only one listener at a time. |
| `The saved WhatsApp login could not be decrypted (TOKEN_ENCRYPTION_KEY changed?)` | Link the device again (the old login is ignored). |
| `you don't follow "…"` | Follow the channel in WhatsApp; posts only arrive from followed channels. |
| `skipped a post from "…"` | That channel is not in `WHATSAPP_CHANNELS`; add the id the message shows. |
| `reading posts with simple rules, because …` | Have a TPO/admin save an LLM key, and set `WHATSAPP_LLM_EMAIL` if several have one. |
| `could not read a post: … no longer available` | The provider retired the model. Set `WHATSAPP_LLM_MODEL` and restart; failed posts are retried on start. |
| `could not read a post: … high demand` | The provider is overloaded; retries happen automatically. |

Limits: only posts that arrive while the listener runs are collected (no history), edited posts
are not re-read, and images without a caption are skipped.

## Adding a polled source

A polled source is an object `{name, async *fetchBatches()}` whose generator yields arrays of

```js
{ externalId, title, company, companyLogo, location, experience, salary, jobType, workType, applyUrl, description, postedAt, categories }
```

(`categories` optional, short lowercase words). Add it to `getPolledSources()` in
`backend/src/modules/job-feed/sources/index.js`, its label to `SOURCE_LABELS` and its name to
`POLLED_SOURCES` / `ALL_SOURCES` in `constants.js`. A push source calls
`jobSyncService.ingest("<name>", jobs)` directly.

## Tests

```bash
cd backend
NODE_ENV=test node --test test/job-feed-*.test.js
```

The tests never touch the network: the global `fetch` throws and sources get fetch stubs.
