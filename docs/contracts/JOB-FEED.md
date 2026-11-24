# Contract — Job feed (open-market jobs, tracker, sync, real AI job search)

Owner: backend module `backend/src/modules/job-feed/` (implementer role **backend:job-feed**), ported from
Matchy. §12 (jobs-finder agent) is implemented by **python:agent-fixes** (see PYTHON.md); §13 lists what the
frontend roles (**frontend:opportunities**, **frontend:tpo**, see FRONTEND.md) consume.

Mounted at `/api/v1/job-feed`. Every response uses the SIH envelope through `core/http.js`
(`send(res, data, message, status)` / `fail(status, message, code, extra)`):
success `{statusCode, data, message, success:true}`, error `{success:false, message, errors:[{code, …}], data:null}`.
Response shapes below describe `data`. Dates are ISO-8601 UTC strings in JSON.

Vocabulary: **campus drive** = SIH `Job` (collection `jobs`, owned by placements). **External job** =
`ExternalJob` (collection `external_jobs`, this module). They never share a model, a collection or an id space.

---

## 0. Port map (Matchy → merged repo)

Matchy root: `/Users/sanyampandey/personal_project/backend/`. Port the logic; do not modify Matchy.

| Matchy file | New file (`backend/src/modules/job-feed/…`) | Changes |
|---|---|---|
| `src/models/job.model.js` | `models/external-job.model.js` | model `ExternalJob`, collection `external_jobs`, + `isSample`, + indexes (§2.1). `toPublicJSON` replaced by `toPublicJob()` (§7.1). |
| `src/services/job-normalizer.service.js` | `normalizer.js` | logic verbatim; `JOB_TYPES`/`WORK_TYPES` come from `constants.js`. |
| `src/repositories/job.repository.js` | `repository.js` | ExternalJob; returns `insertedIds`; field backfill; `isSample`; source counts (§3.2). |
| `src/services/job-sync.service.js` | `sync.service.js` | `start()` removed (scheduler in `index.js`, §5.4); `sync({trigger, triggeredBy})`; `JobSyncRun` persistence; post-run hooks (§5). |
| `src/services/jobs.service.js`, `src/controllers/jobs.controller.js`, `src/routes/jobs.routes.js` | `feed.service.js`, `routes.js` | q / workType / location / sort filters, envelope, per-user saved state (§7). |
| `src/services/job-sources/debug-with-shubham.source.js` | `sources/debug-with-shubham.source.js` | verbatim. |
| `src/services/job-sources/artha.source.js` | `sources/artha.source.js` | verbatim (constructor defaults come from `getJobFeedConfig()`). |
| `src/services/job-sources/whatsapp-channel.source.js` | `whatsapp/channel.source.js` | **no static `baileys` import**; library passed in (§11). |
| `src/services/whatsapp-auth-state.service.js` | `whatsapp/auth-state.service.js` | model `WhatsAppAuthState`; values encrypted with `src/utils/crypto.js`; library passed in. |
| `src/services/whatsapp-job-extractor.service.js` | `whatsapp/job-extractor.service.js` | `loadLlmClient` uses BYOK exports lazily, TPO/admin keys only, `+llmCredentials` (§11.3). |
| `src/services/whatsapp-post.service.js` | `whatsapp/post.service.js` | model `WhatsAppPost` (`whatsapp_posts`). |
| `src/services/whatsapp-listener.service.js` | `whatsapp/listener.service.js` | status tracking; resolves (never throws) when `baileys` is missing. |
| `src/workers/whatsapp-listener.js` | `backend/scripts/job-feed-whatsapp.js` | uses `src/db/db.js` (`DBConnect`). |
| `src/middleware/admin-sync.middleware.js` + `src/routes/admin.routes.js` | `routes.js` → `syncAuth` | header secret **or** tpo/admin JWT; bad secret → 401 (not 404). |
| `test/jobs.test.js`, `test/whatsapp.test.js` | `backend/test/job-feed-*.test.js` | `test/helpers.js`, no network (§16). |
| `JOBS-README.md`, `WHATSAPP-README.md` | `docs/JOB-FEED-OPERATIONS.md` | adapted names, collections, commands, cron example. |

**Removed, never ported:** Matchy `frontend/src/pages/admin-sync-page.jsx`, the `/admin/user/:adminSecret`
route, `VITE_ADMIN_SYNC_SECRET`, `POST /api/admin/jobs/sync`, the 404-on-bad-secret trick (the URL-secret page
concept is gone; the only manual sync is `POST /api/v1/job-feed/sync`, §7.4), the legacy
`backend/.whatsapp-auth/` directory and every `.env` file.

---

## 1. Files

### 1.1 Created by backend:job-feed
```
backend/src/modules/job-feed/
  index.js                          default export {name:"job-feed", mountPath:"/api/v1/job-feed", router, start, tools}
  constants.js                      JOB_TYPES, WORK_TYPES, SAVED_JOB_STATUSES, SOURCE_LABELS, POLLED_SOURCES,
                                    LOCATION_ALIASES, MATCH_CANDIDATE_WINDOW (=500)
  config.js                         getJobFeedConfig() — reads process.env on every call (§15)
  models/external-job.model.js      ExternalJob
  models/saved-job.model.js         SavedJob
  models/job-sync-run.model.js      JobSyncRun
  models/whatsapp-auth-state.model.js  WhatsAppAuthState
  models/whatsapp-post.model.js     WhatsAppPost
  normalizer.js                     cleanUrl, isShortenerHost, normalizeJobType, normalizeWorkType, buildDedupeKey, normalizeJob
  repository.js                     JobRepository
  sync.service.js                   JobSyncService, jobSyncService (singleton), shouldRunBootSync, markInterruptedRuns, purgeStaleJobs
  feed.service.js                   searchMarketJobs, listCategories, listSources, getExternalJob, toPublicJob, resolveMarketJob
  match.js                          buildProfileSignals, scoreExternalJob
  tracker.service.js                listSavedJobs, upsertSavedJob, removeSavedJob, toSavedJobView
  notify.js                         notifyMatchDigest, notifySyncFailure (call notifications/notify.js)
  sample-jobs.js                    SAMPLE_EXTERNAL_JOBS, seedSampleExternalJobs
  routes.js                         Express router (§7)
  tools.js                          agent tools (§10)
  sources/debug-with-shubham.source.js
  sources/artha.source.js
  sources/index.js                  getPolledSources(config)
  whatsapp/baileys.js               loadBaileys() — the ONLY module that references "baileys" (dynamic import)
  whatsapp/status.js                getWhatsAppStatus(), setWhatsAppStatus() — no baileys import
  whatsapp/channel.source.js
  whatsapp/auth-state.service.js
  whatsapp/job-extractor.service.js
  whatsapp/post.service.js
  whatsapp/listener.service.js
backend/scripts/job-feed-whatsapp.js
backend/test/job-feed-sync.test.js
backend/test/job-feed-api.test.js
backend/test/job-feed-tools.test.js
backend/test/job-feed-whatsapp.test.js
docs/JOB-FEED-OPERATIONS.md
```
`backend/src/app.js` and `backend/src/modules/index.js` already mount the module through the registry; nothing
else in the legacy tree is edited by this module.

### 1.2 Changes requested from other owners
- `backend/package.json`: add script `"whatsapp": "node scripts/job-feed-whatsapp.js"`. Keep `baileys` in
  `optionalDependencies` (already `^7.0.0-rc14`); never move it to `dependencies`.
- `backend/.env.example`: the variables of §15 with their defaults and one-line comments.
- `backend/test/helpers.js` (already done; must stay): forces `JOB_SYNC_INTERVAL_MINUTES=0`, `WHATSAPP_ENABLED=false`,
  `DISABLE_SCHEDULER=true`, sets `TOKEN_ENCRYPTION_KEY` and `LLM_CREDENTIAL_ENCRYPTION_KEY`.

---

## 2. Models (all use `mongoose.models.X || mongoose.model("X", schema)`)

### 2.1 `ExternalJob` — `models/external-job.model.js`, collection **`external_jobs`**, `{timestamps:true}`

| field | type | notes |
|---|---|---|
| dedupeKey | String, required, unique | §3.1 |
| title | String, trim, maxlength 300 | |
| company | String, trim, maxlength 200 | |
| companyLogo | String | cleaned URL |
| location | String, trim, maxlength 200 | |
| experience | String, trim, maxlength 100 | free text ("0 - 2 years", "Batch 2026") |
| salary | String, trim, maxlength 100 | free text ("11-21 Lacs P.A.", "USD 50-100 per hour") |
| jobType | String, enum `JOB_TYPES` = `full-time`, `part-time`, `internship`, `contract` | |
| workType | String, enum `WORK_TYPES` = `onsite`, `remote`, `hybrid` | |
| applyUrl | String | cleaned; tracking params are KEPT (only the dedupe key ignores them) |
| description | String, maxlength 10000 | plain text |
| postedAt | Date, required | newest posting date seen (a repost bubbles up) |
| lastSeenAt | Date, required | last time any source reported the job |
| sources | `[{name: String required, externalId: String required}]`, `_id:false` | every source that reported it |
| categories | `[String]` | lowercase fields of work, e.g. `developer`, `data-analyst` |
| isSample | Boolean, default false | true only for demo listings (§14) |

Indexes: `{dedupeKey:1}` unique · `{postedAt:-1, _id:-1}` · `{jobType:1, postedAt:-1}` · `{categories:1, postedAt:-1}` ·
`{"sources.name":1, postedAt:-1}` · `{lastSeenAt:1}` · `{isSample:1}`.

**Read-only for every other module.** Only job-feed (ingest, upsert, purge, sample cleanup) writes it. Resume
tailoring (RESUME-BYOK.md) must keep a manual job description per user/request and never write it into
`ExternalJob.description` (fixes Matchy `llm.controller.js:228-231`).

### 2.2 `SavedJob` — collection **`saved_jobs`**, `{timestamps:true}` (`createdAt` = saved at)

| field | type | notes |
|---|---|---|
| user | ObjectId→User, required | the student |
| job | ObjectId→ExternalJob, required | |
| status | String, enum `SAVED_JOB_STATUSES` = `saved`, `applied`, `interviewing`, `offer`, `rejected`; default `saved` | |
| notes | String, trim, maxlength 2000, default `""` | |
| appliedAt | Date, default null | set when status first becomes `applied`/`interviewing`/`offer`/`rejected` while null; reset to null when status returns to `saved` |
| statusChangedAt | Date, required | |
| history | `[{status: String, at: Date}]`, `_id:false` | appended on create and on every status change; keep the last 20 (`$push` with `$slice:-20`) |
| snapshot | `{title, company, location, applyUrl, jobType, workType, salary, postedAt: Date, sources: [String]}` | copied from the job on create, so the tracker survives purges |

Indexes: `{user:1, job:1}` unique · `{user:1, status:1, updatedAt:-1}` · `{job:1}`.
Campus drives are never stored here (they are tracked by placements' Application model).

### 2.3 `JobSyncRun` — collection **`job_sync_runs`**, `{timestamps:false}`

| field | type | notes |
|---|---|---|
| trigger | enum `boot`, `schedule`, `manual`, `cron`, `agent`; required | |
| triggeredBy | ObjectId→User, default null | JWT/agent triggers |
| status | enum `running`, `ok`, `partial`, `failed`; required | ok = no source error; partial = ≥1 error and ≥1 success; failed = every polled source errored, or a run-level error |
| startedAt | Date, required | |
| finishedAt / durationMs | Date / Number | |
| results | `[{source, received, inserted, duplicates, skipped, error, durationMs}]` (`error`: String or null), `_id:false` | one per polled source, in run order |
| totals | `{received, inserted, duplicates, skipped}` | sums |
| sampleJobsRemoved | Number, default 0 | §14.3 |
| error | String | run-level error, e.g. `Interrupted by a server restart` |

Indexes: `{startedAt:1}` with `expireAfterSeconds: 2592000` (30 days; also serves newest-first sorts) · `{status:1, startedAt:-1}`.

### 2.4 `WhatsAppAuthState` — collection **`whatsapp_auth_state`**, `{timestamps:true}`
`_id: String` (Baileys key name: `creds`, `<type>-<id>`), `value: String` required =
`encrypt(JSON.stringify(value, BufferJSON.replacer))` with `encrypt/decrypt` from `src/utils/crypto.js`
(AES-256-GCM, `TOKEN_ENCRYPTION_KEY`). Holds linked-device keys: never returned by an API, never logged.

### 2.5 `WhatsAppPost` — collection **`whatsapp_posts`**, `{timestamps:true}`
Matchy fields unchanged: `channelJid` (required), `channelName`, `messageId` (required), `text`, `postedAt`,
`status` (enum `saved|ignored|failed`, required), `extractedWith` (enum `llm|rules`), `jobCount` (0),
`newJobCount` (0), `attempts` (0), `reason`, `error`.
Indexes: `{channelJid:1, messageId:1}` unique · `{status:1, postedAt:1}` · `{createdAt:1}` with `expireAfterSeconds: 2592000`.

---

## 3. Normalisation, dedupe and persistence

### 3.1 `normalizer.js` (verbatim port)
Keep every rule of `job-normalizer.service.js`: NFKC `cleanText` + `MAX_LENGTHS`, `cleanDescription` (keeps
newlines), lowercase deduped `categories`, `cleanUrl` repairs (`:https://`, `ttps://`, `https:// x`, bare domains,
trailing `?`/`&`, dotted host, rejects `mailto:`), `TRACKING_PARAMS`, `SHORTENER_HOSTS`, `COMPANY_SUFFIXES`,
`JOB_TYPE_LOOKUP` / `WORK_TYPE_LOOKUP`, future or invalid `postedAt` → `seenAt`. `normalizeJob(input, {source, seenAt})`
returns `null` (counted as skipped) without `source`, `externalId`, or one of (`title`, valid `applyUrl`).
Dedupe key priority: `url:<host><path>[?query][#route]` (non-shortener URL containing a job id) →
`url+title:<urlKey>#<company>|<title>` → `text:<company>|<title>` → `source:<source>:<externalId>`.

### 3.2 `repository.js`
- `list(filter, {skip, limit, sort})`, `count(filter)`.
- `listCategories()` → `[{value, count}]` sorted `count desc, value asc` (Matchy aggregation).
- `listSourceCounts()` → `{<sourceName>: count}` (`$unwind: "$sources"`, group by `sources.name`, count distinct jobs).
- `upsertMany(jobs, seenAt, {source})` → `{inserted, existing, insertedIds: ObjectId[]}`:
  1. `ExternalJob.bulkWrite(ops, {ordered:false})`, one `updateOne` per job, `upsert:true`, filter `{dedupeKey}`, update
     `$setOnInsert: <non-null of title, company, companyLogo, location, experience, salary, jobType, workType, applyUrl, description>`
     (+ `isSample:true` when `source === "sample"`), `$max: {postedAt}`, `$set: {lastSeenAt: seenAt}` (+ `isSample:false`
     when `source !== "sample"`), `$addToSet: {sources: {$each}, categories: {$each}}`. `insertedIds` =
     `Object.values(result.upsertedIds)`.
  2. **Backfill** (new, fixes "a description from a later source is never stored"): for every job with ≥1 non-null
     field among `company, companyLogo, location, experience, salary, jobType, workType, applyUrl, description`,
     one pipeline update sent through the **native driver** (`ExternalJob.collection.bulkWrite(ops, {ordered:false})`,
     because Mongoose 9 rejects array updates without `updatePipeline`):
     `{updateOne: {filter: {dedupeKey}, update: [{$set: {<field>: {$ifNull: ["$<field>", {$literal: <value>}]}, …, updatedAt: "$$NOW"}}]}}`.
     Existing non-null values are never overwritten.

---

## 4. Sources

No source needs credentials or API keys. A polled source is `{name, async *fetchBatches()}` yielding arrays of
raw inputs `{externalId, title, company, companyLogo, location, experience, salary, jobType, workType, applyUrl,
description, postedAt, categories?}`. Constructors accept `{fetchImpl}` (tests); artha also
`{keywords, location, countries}`.

| name | label | kind | enabled when | upstream | paging / timeout | notes |
|---|---|---|---|---|---|---|
| `debugwithshubham` | DebugWithShubham | poll | always (every sync) | `GET https://debugwithshubham-web-page.onrender.com/api/jobs/?page=<n>&limit=200&jobType=<FullTime\|Internship\|Contract>` | 3 job types × ≤25 pages, stop at a page with <200 rows; 60 s per request (Render cold start) | maps `id, role, company_name, company_logo, location, experience, salary, job_type, work_type, apply_url, posted_at` (IST wall clock → `+05:30`). No description, no categories. Third-party feed, no SLA. |
| `artha` | artha.link | poll | `FROM_ARTHA=true` | `POST https://artha.link/api/job-api/recommend?pulse_variant=pulse`, JSON body exactly as `artha.source.js` `fetchPage` (portal id/slug constants copied unchanged from `artha.source.js:1-8`; public identifiers, not secrets) | one search per keyword (`ARTHA_KEYWORDS`, else the 25 `DEFAULT_KEYWORDS`), ≤20 pages × 100; 30 s | undocumented internal API (may break); `keywordMatcher` categories; HTML → text; `applyUrl = https://artha.link/@placerohq/jobs/<slug>` (the signed `url` is ignored); `ARTHA_LOCATION`, `ARTHA_COUNTRIES` |
| `whatsapp` | WhatsApp | push | `WHATSAPP_ENABLED=true` (inside the API) or `npm run whatsapp` (standalone), **and** `baileys` installed, **and** valid `TOKEN_ENCRYPTION_KEY` | WhatsApp Web linked-device protocol | live channel posts ≤3 days old | off by default (§11) |
| `sample` | Sample | seed | demo seed only | — | — | §14 |

`constants.js`: `POLLED_SOURCES = ["debugwithshubham", "artha"]`; `SOURCE_LABELS = {debugwithshubham: "DebugWithShubham",
artha: "artha.link", whatsapp: "WhatsApp", sample: "Sample"}`; `SAVED_JOB_STATUSES` (§2.2); `MATCH_CANDIDATE_WINDOW = 500`.

`sources/index.js` → `getPolledSources(config = getJobFeedConfig())` returns
`[new DebugWithShubhamJobSource(), ...(config.fromArtha ? [new ArthaJobSource({keywords: config.arthaKeywords, location: config.arthaLocation, countries: config.arthaCountries})] : [])]`,
evaluated **per sync** (Matchy evaluated it once at module load).

---

## 5. Sync service, scheduler, offline behaviour

### 5.1 `JobSyncService` (`sync.service.js`)
```js
class JobSyncService {
  constructor({ repository = new JobRepository(), sources = null, persist = true, afterRun = defaultAfterRun } = {})
  sources                        // public: null → getPolledSources() at each run; tests assign fake sources here
  ingest(source, inputs, seenAt = new Date())   // → {received, inserted, duplicates, skipped, insertedIds}
  syncSource(source)                             // → {source, received, inserted, duplicates, skipped, error, durationMs, insertedIds}
  sync({ trigger = "manual", triggeredBy = null } = {})   // → Promise<PublicRun>, single-flight
  isRunning()                                    // → boolean
  current()                                      // → PublicRun | null (status "running")
}
export const jobSyncService = new JobSyncService();
```
- `ingest`: normalise, merge in-batch duplicates (newest `postedAt`, concatenated sources, unioned categories),
  `upsertMany`; `duplicates = received - skipped - inserted` (Matchy). Push sources (WhatsApp) call it directly.
- `sync` is **single-flight**: while a run is in progress every caller gets the same promise (same resolved object;
  the first caller's trigger is recorded). `current()` is set synchronously inside `sync()` before its first `await`
  (an `_id` is pre-generated), so a route can answer 202 with the running run immediately.
- Sources run sequentially. Each source is wrapped in try/catch: a failure records
  `error = err.message || "The source could not be synced."`, keeps the batches already saved, and the next source runs.
- After the sources: compute `totals` and `status`; run sample cleanup (§14.3); persist the run (`persist:true`:
  insert at start with status `running`, update at the end; a DB error while persisting is logged, never thrown);
  then `afterRun(run, {insertedIds, previousRun})`, best-effort (each hook in its own try/catch).
- `defaultAfterRun`: emit `job-feed:sync` (finished run) to `role:tpo` + `role:admin`; emit `job-feed:updated`
  when real inserts > 0 (§8); `notifyMatchDigest` (§9.1); `notifySyncFailure` (§9.2).
- At start (before the first source) emit `job-feed:sync` with the running run.
- Logging: one line per run — `[job-feed] sync <trigger> <status> in 12.3s — debugwithshubham: 3 new, 1258 known, 0 skipped; artha.link: failed (The artha.link jobs API returned HTTP 503.)`. No stack traces for source errors.

`PublicRun` (JSON): `{id, trigger, triggeredBy: {id, name} | null, status, startedAt, finishedAt, durationMs,
results: [{source, label, received, inserted, duplicates, skipped, error, durationMs}], totals, sampleJobsRemoved, error}`.

### 5.2 Offline behaviour (must hold)
If every source fails (no network, DNS error, upstream down) the run ends `failed`, nothing is deleted or
modified, existing jobs (including sample listings) stay listed, the run is persisted with each source's error,
one log line is written per failing source, the promise resolves (never rejects), and the next scheduled tick
retries. The API keeps serving `GET /api/v1/job-feed` from MongoDB at all times; no request ever calls a source.

### 5.3 Helpers (exported, pure or DB-only, all unit-tested)
- `shouldRunBootSync({lastSuccessfulRun, now, intervalMinutes})` → true when there is no `ok|partial` run or its
  `startedAt < now − (intervalMinutes > 0 ? intervalMinutes : 60) min` (stops dev restarts from hammering feeds).
- `markInterruptedRuns(now)` → `JobSyncRun.updateMany({status:"running"}, {$set:{status:"failed", finishedAt:now, error:"Interrupted by a server restart"}})`; returns the count (single-process deployment, as `core/scheduler.js`).
- `purgeStaleJobs({retentionDays, now})` → deletes `{isSample:false, lastSeenAt:{$lt: now − retentionDays d}, _id:{$nin: await SavedJob.distinct("job")}}`; returns `{deleted}`; logs when > 0.

### 5.4 `index.js` → `start()` (called once after MongoDB connects)
```js
const config = getJobFeedConfig();
await markInterruptedRuns(new Date());
if (config.syncIntervalMinutes > 0)
  registerJob("job-feed:sync", config.syncIntervalMinutes * 60_000, () => jobSyncService.sync({ trigger: "schedule" }));
if (config.retentionDays > 0)
  registerJob("job-feed:purge", 24 * 60 * 60_000, () => purgeStaleJobs({ retentionDays: config.retentionDays, now: new Date() }));
if (isSchedulerEnabled() && config.syncOnBoot)
  setTimeout(() => runBootSyncIfStale(config), 5_000).unref();   // trigger "boot"; uses shouldRunBootSync
if (config.whatsappEnabled && process.env.NODE_ENV !== "test")
  import("./whatsapp/listener.service.js").then(({ startWhatsAppListener }) => startWhatsAppListener({
    onFatal: (message) => console.error(`[job-feed] WhatsApp: ${message} The API keeps running.`),
  })).catch((error) => console.error("[job-feed] WhatsApp listener failed to start:", error.message));
```
`registerJob` / `isSchedulerEnabled` come from `core/scheduler.js` (disabled under `NODE_ENV=test` or
`DISABLE_SCHEDULER=true`; tests call `jobSyncService.sync()` directly). `start()` never throws.

---

## 6. Match scoring (`match.js`, deterministic, explainable)

`buildProfileSignals(user)` → `null` when the user has no skills, no preferred roles and no preferred locations; else
`{skills, roles, locations, prefersRemote}`:
- `skills` = unique lowercase trimmed `user.skills` + `user.projects[].skills`, 2–40 chars each, at most 40.
- `roles` = `user.careerPreferences.preferredRoles` (strings, lowercase). `locations` = `careerPreferences.preferredLocations`
  canonicalised with `LOCATION_ALIASES`; `prefersRemote` = locations include `remote`.

`scoreExternalJob(job, signals, now)` → `{score: 0..100 | null, matchedSkills: string[]}` (`null` score when `signals` is null):
- haystack = lowercase `title + " " + categories.join(" ") + " " + (description || "")`.
- **skills (0–50)**: a skill matches when found with boundaries `(^|[^a-z0-9+#.])<escaped skill>($|[^a-z0-9+#])`
  (so `java` ≠ `javascript`, `sql` ≠ `postgresql`, `node.js`/`c++`/`c#` work); `50 × min(matched, d) / d` with `d = min(skills.length, 6)`.
- **role (0–30)**: 30 if every word (≥3 chars, not one of `and, the, for, with, of, in, at`) of some preferred role appears
  word-prefix-wise (`(^|[^a-z0-9])word`) in the lowercase title; else 15 if any such word appears in the title; else 0.
- **location (0–10)**: 10 if the job location contains a preferred location (alias-aware) or `prefersRemote && workType === "remote"`.
- **freshness (0–10)**: 10 if `postedAt` ≤ 3 days old, 5 if ≤ 14 days, else 0.
- `score = round(min(100, sum))`; `matchedSkills` = matched skills in the user's original casing, max 5.

`LOCATION_ALIASES` groups (also used by the `location` filter): `[bengaluru, bangalore]`, `[gurugram, gurgaon]`,
`[mumbai, bombay]`, `[chennai, madras]`, `[kolkata, calcutta]`, `[kochi, cochin]`, `[thiruvananthapuram, trivandrum]`,
`[visakhapatnam, vizag]`, `[mysuru, mysore]`, `[delhi, new delhi, ncr]`.

---

## 7. REST API (`routes.js`, mounted at `/api/v1/job-feed`)

Registration order (so `/:id` never shadows a named path):
```
POST   /sync            syncAuth, syncRateLimit           (secret header OR tpo/admin JWT)
router.use(requireAuth)
GET    /                any role
GET    /categories      any role
GET    /sources         any role
GET    /sync/status     requireRole("tpo")    (admin passes)
GET    /saved           requireRole("student") (admin passes)
PUT    /saved/:jobId    requireRole("student")
DELETE /saved/:jobId    requireRole("student")
GET    /:id             any role
```
Error codes used (`errors[0].code`): `VALIDATION` (400, with `field`), `UNAUTHORIZED`/no code (401 from `verifyJWT`),
`INVALID_SYNC_SECRET` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `TOO_MANY_ATTEMPTS` (429).

### 7.1 Public job shape (`toPublicJob(doc, {now, saved, match})`)
```
PublicExternalJob = {
  id, kind: "external", title|null, company|null, companyLogo|null, location|null, experience|null, salary|null,
  jobType|null, workType|null, applyUrl|null, description|null, postedAt, lastSeenAt, createdAt,
  sources: string[],            // unique source names, first-seen order
  categories: string[], isSample: boolean,
  isNew: boolean,               // postedAt within 24 h of now
  saved: null | {status, notes, savedAt, appliedAt},     // viewer's tracker entry (students); null otherwise
  matchScore?: number|null, matchedSkills?: string[]     // present when ranked (sort=match, tools, digest)
}
```

### 7.2 `GET /api/v1/job-feed` — list / search
Query (all optional):

| param | rule |
|---|---|
| `q` | trimmed, cut to 100 chars; tokens = whitespace split, tokens <2 chars dropped, max 6; **every** token (escaped with `escapeRegex`, case-insensitive) must match one of `title, company, location, categories, description` (AND of ORs). `c++`, `.net`, `(` are safe. |
| `jobType` | `normalizeJobType()` (accepts `FullTime`, `intern`, …); unknown → 400 `VALIDATION` `field:"jobType"` "Unknown job type. Use one of: full-time, part-time, internship, contract." |
| `workType` | `normalizeWorkType()`; unknown → 400 `VALIDATION` `field:"workType"` |
| `category` | trimmed lowercase, ≤60 chars, exact element match on `categories` |
| `source` | lowercase exact match on `sources.name`; unknown names simply match nothing |
| `location` | ≤60 chars; case-insensitive regex on `location`, expanded with `LOCATION_ALIASES` (`Bangalore` finds `Bengaluru`) |
| `sort` | `newest` (default: `{postedAt:-1,_id:-1}`) or `match` (score the newest `MATCH_CANDIDATE_WINDOW`=500 matching docs for the viewer, order `matchScore desc` (null last), then `postedAt desc`, paginate in memory); anything else → 400 `VALIDATION` `field:"sort"` |
| `page` | `intParam(page, {min:1, max:1000, fallback:1})` |
| `limit` | `intParam(limit, {min:1, max:50, fallback:20})` |

`200` → `{jobs: PublicExternalJob[], page, limit, total, hasNextPage, filters: {q, jobType, workType, category, source, location, sort}}`
(`total` = count of matching docs; for `sort=match`, `hasNextPage = page*limit < min(total, 500)`). For a student, `saved`
is filled with ONE `SavedJob.find({user, job:{$in: pageIds}})`. Implemented by
`searchMarketJobs({q, category, jobType, workType, location, source, sort, page, limit, viewer, now})` (also used by the tool).

### 7.3 `GET /categories` → `{categories: [{value, count}]}` (Matchy shape, most common first).

### 7.4 `POST /sync` — manual / cron sync (replaces the URL-secret page)
Auth (`syncAuth`): if header `x-admin-sync-secret` is present → it must equal `ADMIN_SYNC_SECRET` (length check +
`crypto.timingSafeEqual`), trigger `cron`; when the env var is empty or the value differs → `401 INVALID_SYNC_SECRET`
"Invalid sync secret". Without the header → `requireAuth` then `requireRole("tpo")` (admin passes), trigger `manual`,
`triggeredBy = req.user._id`. Rate limit: `rateLimit({windowMs: 60_000, max: 3, keyFn: req => req.user?._id || "cron"})` (skipped in tests).
- default → `202 {run: PublicRun (status "running"), alreadyRunning: boolean}` immediately; the run continues in the background
  (`.catch` logged). The frontend's 30 s axios timeout is never hit.
- `?wait=true` → waits for the run → `200 {run}` (cron: `curl -X POST -H "x-admin-sync-secret: $ADMIN_SYNC_SECRET" "$API/api/v1/job-feed/sync?wait=true"`).

### 7.5 `GET /sync/status` (tpo/admin)
```
{
  running: boolean, current: PublicRun|null,
  lastRun: PublicRun|null, lastSuccessfulRun: PublicRun|null, recentRuns: PublicRun[]   // ≤10, newest first
  schedule: { intervalMinutes, onBoot, enabled /* interval>0 && isSchedulerEnabled() */, nextRunAt /* lastRunAt+interval from listJobs(), or null */ },
  sources: SourceInfo[],                                   // same as GET /sources
  whatsapp: WhatsAppStatus,                                // §11.4
  totals: { jobs, sampleJobs, savedJobs, newLast24h }
}
```

### 7.6 `GET /sources` → `{sources: SourceInfo[]}`
`SourceInfo = {name, label, kind: "poll"|"push"|"seed", enabled, count, lastSyncedAt, lastError}` for
`debugwithshubham`, `artha`, `whatsapp`, `sample` (in that order). `count` from `listSourceCounts()`;
`lastSyncedAt` = `finishedAt` of the newest run where that source had no error (WhatsApp: newest `saved` post's
`updatedAt`; sample: null); `lastError` = the source's error in the newest run that included it, else null.

### 7.7 Tracker (students; admin passes `requireRole`)
`SavedJobView = {id, jobId, status, notes, savedAt, appliedAt, statusChangedAt, updatedAt, history: [{status, at}],
job: PublicExternalJob (without saved) | null, snapshot: {title, company, location, applyUrl, jobType, workType, salary, postedAt, sources}, jobAvailable: boolean}`
- `GET /saved?status=&page=&limit=` (`status` must be in `SAVED_JOB_STATUSES` else 400; limit default 50 max 100; sorted `updatedAt desc`)
  → `{items: SavedJobView[], counts: {saved, applied, interviewing, offer, rejected, total}, page, limit, total, hasNextPage}`.
- `PUT /saved/:jobId` body `{status?, notes?}` — idempotent upsert keyed by `(user, jobId)`:
  `jobId` not an ObjectId → 400 `VALIDATION`; invalid `status` → 400 `field:"status"`; `notes` not a string or >2000 → 400 `field:"notes"`.
  Existing entry → update (allowed even if the job was purged) → `200 {item}`. No entry → the ExternalJob must exist
  (else `404 NOT_FOUND` "This job is no longer in the feed.") → create with `status ?? "saved"` and snapshot → `201 {item}`.
  `appliedAt` / `statusChangedAt` / `history` per §2.2.
- `DELETE /saved/:jobId` → `200 {deleted: true}`; not saved → `404 NOT_FOUND`.

### 7.8 `GET /:id`
Invalid id → 400 `VALIDATION`; missing → `404 NOT_FOUND` "This job is no longer in the feed."; else
`200 {job: PublicExternalJob}` with `saved` (students) and `matchScore`/`matchedSkills` for the viewer.

---

## 8. Socket events (server → client, via `core/realtime.js`)

| event | rooms | payload | when |
|---|---|---|---|
| `job-feed:sync` | `role:tpo`, `role:admin` (`emitToRole`) | `{run: PublicRun}` | when a run starts (`running`) and when it finishes |
| `job-feed:updated` | `role:student`, `role:tpo`, `role:admin` | `{inserted, source: "sync"\|"whatsapp", at}` | a sync run or a WhatsApp post inserted ≥1 non-sample job |

No client → server events.

---

## 9. Notifications (only through `notify()` from `modules/notifications/notify.js`)

### 9.1 `jobfeed.matches` — daily "new jobs match your profile" digest
- When: after a sync run whose non-sample inserts > 0, unless `JOB_FEED_MATCH_DIGEST=false`.
- Candidates: up to the 200 newest jobs inserted by this run. Recipients: `role:"student"`, `isActive ≠ false`, with ≥1 skill
  or preferred role; read with a cursor in batches of 200, `await new Promise(setImmediate)` between batches.
- Per student: jobs with `score ≥ 60`, best first; none → no notification.
- `title`: `"${n} new job${n === 1 ? "" : "s"} match your profile"`; `body`: `"<Title> at <Company>, <Title> at <Company> and ${n - 2} more."`
  (only as many labels as exist, ≤1000 chars); `ui`: `{panel: "jobs.market", params: {sort: "match", highlightIds: [≤10 ids]}}`;
  `data`: `{jobIds: [≤10], runId}`; `priority:"low"`, `push:false`, `email:false`;
  `dedupeKey: "jobfeed-matches:<YYYY-MM-DD in APP_TIMEZONE>"` (≤1 per student per day).

### 9.2 `jobfeed.sync.failed` — feed is down
- When: a run ends `failed` and the previous finished run was not `failed` (or there was none).
- Recipients: every user with role `tpo` or `admin` and `isActive ≠ false`.
- `title`: `"Job feed sync failed"`; `body`: `"No source could be reached (<label>: <error>; …). Existing jobs are kept; the next automatic attempt is in <N> min."`
  (or `"…automatic syncing is off (JOB_SYNC_INTERVAL_MINUTES=0)."`), ≤1000 chars; `ui`: `{panel:"tpo.jobfeed", params:{runId}}`;
  `data`: `{runId}`; `priority:"normal"`, `push:false`; `dedupeKey: "jobfeed-sync-failed:<YYYY-MM-DD>"`.

Tracker actions and searches never notify.

---

## 10. Agent tools (`tools.js`, names fixed by AGENT-TOOLS.md §5)

Handlers use `ctx.user` (fresh User doc), reuse `feed.service.js` / `tracker.service.js`, and throw `fail(...)`
(ApiError) for user errors. Free-text job references use `resolveMarketJob(ref, {user})`:
ObjectId → `findById` (missing → `404 NOT_FOUND` "No open-market job has id <ref>. Campus drives are applied to with drive_apply.");
otherwise text (≤200 chars; `"<title> at <company>"` splits on the last ` at `): first the user's saved jobs (snapshot
title/company), then the newest 500 jobs, AND-of-tokens regex on title/company; 1 hit → it; 0 → `404 NOT_FOUND`
"No open-market job matches '<ref>'."; >1 → `{ambiguous: true, message: "Several jobs match '<ref>'. Which one?",
candidates: [{id, label: "<Title> — <Company> (<Location>)"}]}` (≤5, newest first).
`jobLabel(job)` = `“<title>” at <company>` (`“<title>”` without company; `"<company> role"` without title).

| tool | roles | confirm | parameters (JSON schema) |
|---|---|---|---|
| `jobs_search_market` | student, teacher, tpo, company, admin, alumni | – | `{query?: string, category?: string, jobType?: enum JOB_TYPES, workType?: enum WORK_TYPES, location?: string, source?: enum ["debugwithshubham","artha","whatsapp","sample"], sort?: enum ["match","newest"], limit?: integer}` |
| `market_job_save` | student | – | `{job: string (required), notes?: string}` |
| `market_job_mark_applied` | student | – | `{job: string (required), notes?: string}` |
| `job_feed_sync` | tpo, admin | ✓ | `{}` |

(`workType`, `location`, `sort` are additive optional args to the AGENT-TOOLS.md §5 row.)

LLM-facing descriptions (use verbatim):
- `jobs_search_market`: "Search the open-market job feed: jobs aggregated from external job boards (and WhatsApp job channels when enabled), NOT the college's campus drives (use jobs_search_campus for those). Every word of `query` must appear in the job's title, company, location, categories or description. Results are ranked by fit with the user's profile (sort 'match', the default for students) or newest first."
- `market_job_save`: "Save an open-market job to the student's job tracker with status 'saved'. `job` is a job id from jobs_search_market results, or its title and company, e.g. 'Data Analyst Intern at Northwind Analytics'. Campus drives cannot be saved; students apply to them with drive_apply."
- `market_job_mark_applied`: "Mark an open-market job as applied in the student's job tracker (adds it if needed). Use after the student says they applied on the company's site. `job`: id or 'title at company'."
- `job_feed_sync`: "Fetch the latest jobs from the external sources into the open-market feed now (it also runs automatically every hour). TPO/admin only."

Behaviour and results (`{summary, data, ui}`):
- **`jobs_search_market`**: `limit` clamped 1–20 (default 8); `sort` default `match` for students, `newest` otherwise;
  `searchMarketJobs({q: query, …, page: 1, viewer: ctx.user})`.
  `summary`: `"Found <total> open-market job(s)<facets>. Top matches: 1) <Title> — <Company> (<Location>)[ · <score>% fit]; 2) …"` (≤5 listed) or
  `"No open-market jobs match<facets>. Try fewer keywords or another location."`, where `<facets>` = ` for “<query>”` + ` · <jobType>` + ` · <workType>` + ` · <location>` + ` · <category>` + ` · <source label>` (only present ones).
  `data`: `{jobs: PublicExternalJob[] (with matchScore, matchedSkills, saved), total, filters}`.
  `ui`: `{panel: "jobs.market", params: {q, category, jobType, workType, location, source, sort, highlightIds: [returned ids]}}` (null keys omitted).
- **`market_job_save`**: create with status `saved` (notes when given). Already tracked → status unchanged (notes updated
  if given). `summary`: new `"Saved <jobLabel> to your job tracker."`, existing `"<jobLabel> is already in your tracker (<status>)."`.
  `data`: `{item: SavedJobView, created}`; `ui`: `{panel: "jobs.tracker", params: {highlightId: <jobId>}}`.
- **`market_job_mark_applied`**: if current status is `interviewing`, `offer` or `rejected` → unchanged,
  `"<jobLabel> is already marked as <status>."`; otherwise set `applied` (creating if needed) →
  `"Marked <jobLabel> as applied on <D MMM in APP_TIMEZONE>. Good luck!"`. `data`: `{item, created, previousStatus: string|null}`;
  `ui`: `{panel: "jobs.tracker", params: {status: "applied", highlightId: <jobId>}}`.
- **`job_feed_sync`**: `preview` → `{summary: "Fetch the latest jobs now from <labels joined with ' and '>? It usually takes under a minute; existing jobs are kept if a source is down."` (+ `" A sync is already running (started <HH:mm>); confirming will wait for it."`), `args: {}}`.
  `handler`: `Promise.race([jobSyncService.sync({trigger: "agent", triggeredBy: ctx.user._id}), 15 s])`.
  Finished → `summary`: `"Job feed sync <finished|finished with errors|failed> in <s>s: <inserted> new, <duplicates> already known, <skipped> skipped."` + `" <label> failed: <error>."` per failed source + (`failed` → `" Existing jobs were kept."`); `data`: `{run, finished: true}`.
  Still running → `"The sync is running (started <HH:mm>); results will appear in the Job feed panel when it finishes."`, `data`: `{run: current(), finished: false}`.
  `ui`: `{panel: "tpo.jobfeed", params: {runId}}`.

---

## 11. WhatsApp channels (optional, OFF by default)

### 11.1 Optional dependency rules (must hold)
- `whatsapp/baileys.js`: `export const loadBaileys = async (importer = () => import("baileys")) => { try { return await importer(); } catch { return null; } }`
  (memoised for the default importer). No other file references `baileys`; nothing imports it at module load.
- `index.js` imports `whatsapp/listener.service.js` lazily and only when enabled (§5.4). `routes.js`/`feed.service.js` only import `whatsapp/status.js`.
- With `baileys` absent (`npm install --omit=optional`), `node -e 'import("./src/app.js")'` and the whole API work; an enabled
  listener ends in state `unavailable` with reason `The optional "baileys" package is not installed, so WhatsApp channels are off.`
- `TOKEN_ENCRYPTION_KEY` missing/invalid → state `unavailable`, reason `TOKEN_ENCRYPTION_KEY (64 hex chars) is required to store the WhatsApp login.`

### 11.2 Behaviour (port as-is)
`parseChannelList(WHATSAPP_CHANNELS)` (links, invite codes, `<digits>@newsletter`, `all`); `toChannelPost(message, lib)` and
`useMongoAuthState(lib)` / `clearMongoAuthState()` take the loaded library as an argument (`lib.isJidNewsletter`,
`normalizeMessageContent`, `toNumber`, `BufferJSON`, `initAuthCreds`, `proto`); only channel posts ≤3 days old from allowed
channels (or `all`); `looksLikeJobPost` gate; `expandUrl` follows redirects only on shortener hosts (≤5 hops, 8 s, `redirect:"manual"`);
rules extraction without an LLM, LLM extraction with `EXTRACTION_PROMPT` and `parseLlmJobs` (apply URL must be in the post);
temporary LLM failures retried after 5 s and 20 s; `WhatsAppPostService.handle` idempotency (skip non-failed records, `$unset`
stale fields, `$inc attempts`); `retryFailed` on start (uncapped) and every 15 min (≤5 attempts) in the same serial queue;
reconnect backoff `[2s,5s,10s,30s,60s]`; `loggedOut` → `clearMongoAuthState()` + fatal; `connectionReplaced`/`forbidden` → fatal
(the API keeps running); QR printed in the server terminal, or an 8-character pairing code when `WHATSAPP_PAIRING_NUMBER` is set;
`markOnlineOnConnect:false`, no history sync, never sends messages or read receipts. Ingest:
`jobSyncService.ingest("whatsapp", jobs.map((job, i) => ({...job, externalId: `${channelJid}:${messageId}:${i}`, description: post.text, postedAt: post.postedAt})))`;
when `newJobCount > 0` emit `job-feed:updated`.
Auth state: values encrypted (§2.4); a value that fails to decrypt is treated as missing and logged once
(`The saved WhatsApp login could not be decrypted (TOKEN_ENCRYPTION_KEY changed?); link the device again.`).

### 11.3 LLM for extraction — `loadLlmClient({email, provider, model, importByok})`
Defaults from config (`WHATSAPP_LLM_EMAIL/PROVIDER/MODEL`), `importByok = () => import("../../byok/index.js")`.
Only TPO/admin keys are ever used (a student's paid key is never spent on feed ingestion):
- email set → `User.findOne({email: lower, role: {$in: ["tpo","admin"]}}).select("+llmCredentials email role")`; else
  `User.find({role: {$in: ["tpo","admin"]}, "llmCredentials.0": {$exists: true}}).select("+llmCredentials email role").limit(2)`.
- `{client: null, reason}` reasons (exact): `no TPO or admin account has saved an LLM key yet` · `several TPO/admin accounts have LLM keys, so set WHATSAPP_LLM_EMAIL` ·
  `no TPO or admin account has the email <email>` · `<email> has no saved <provider|LLM> key` · `the BYOK module is not available` ·
  `the saved <provider> key could not be used: <message>`.
- client = `new GenericLlmClient(credential.provider, decryptApiKey(credential.encryptedApiKey), model || credential.model)`
  using the named exports `decryptApiKey` and `GenericLlmClient` of `backend/src/modules/byok/index.js` (RESUME-BYOK.md).
  Success → `{client, description: "<provider> (<model>) from <email>"}`. Without a client the listener uses rules.

### 11.4 Status (`whatsapp/status.js`)
`WhatsAppStatus = {enabled, state: "disabled"|"unavailable"|"starting"|"waiting-for-link"|"connected"|"reconnecting"|"stopped",
reason: string|null, channels: number /* allowed channels, -1 for "all" */, extractor: "llm"|"rules"|null, lastPostAt, posts: {saved, ignored, failed} /* since start */}`.
Never includes the phone number, account name, QR or keys.

### 11.5 Standalone worker `backend/scripts/job-feed-whatsapp.js`
`DBConnect()` (from `src/db/db.js`) → `startWhatsAppListener({onFatal: msg => shutdown(1, msg)})`; SIGINT/SIGTERM →
`listener.stop()` → `mongoose.disconnect()` → exit. Run one listener per WhatsApp login (in-API or standalone, never both).
`docs/JOB-FEED-OPERATIONS.md` documents linking, the spare-number recommendation (ban risk) and settings.

---

## 12. Python jobs-finder: real search + real wishlist (implemented by python:agent-fixes)

### 12.1 Goals
- Delete every path that asks an LLM to produce job listings: `_stream_domain_jobs_from_gemini` and its call in `run()` go;
  nothing may emit a job that did not come from a tool result or from crawling the URL the user gave.
- Non-URL searches call the Node tools `jobs_search_campus` (placements) and `jobs_search_market` (§10) through
  `meta_data.tools_url` + `meta_data.tool_token`, and stream the existing `mode:jobparser:jobslist` payload with the item shape of §12.5.
- Wishlist and "mark as applied" persist through `market_job_save` / `market_job_mark_applied`.
- URL crawling (Mode 1) stays as it is; its items get the §12.5 shape.
- Every remaining Gemini call (wishlist-target fallback, details intent fallback, details streaming) goes through the shared
  Gemini client of PYTHON.md (`x-goog-api-key` header, never `?key=`); `self.stream_endpoint` is removed.

### 12.2 Files

| file | change |
|---|---|
| `ai-service/app/agents/jobscrapper/job_finder.py` | new search / wishlist / applied flows (§12.6–12.8); details prompt hardening (§12.8) |
| `ai-service/app/agents/jobscrapper/search.py` (new) | `extract_search_args`, `campus_item`, `market_item`, `crawl_item`, `merge_items`, `KNOWN_LOCATIONS` |
| `ai-service/app/agents/jobscrapper/formatter.py` | `format_job_for_data` → §12.5 item (idempotent; legacy crawl dicts → `crawl_item`); `format_jobs_markdown` → §12.7 |
| `ai-service/app/agents/jobscrapper/session_store.py` | `replace_jobs(session_id, items)` replaces `save_jobs` (a new search replaces the cached list, so "job 2" is the 2nd card on screen); `update_job(session_id, job_id, **fields)`; entries expire after `JOBS_SESSION_TTL_SECONDS` (7200) idle, at most `JOBS_SESSION_MAX` (500) sessions (oldest evicted) |
| `ai-service/app/agents/job_creator/agent.py` | routing veto (§12.9) |
| `ai-service/app/config.py` | `JOBS_FINDER_MAX_RESULTS` (12), `JOBS_FINDER_CAMPUS_LIMIT` (6), `JOBS_FINDER_TOOL_TIMEOUT_SECONDS` (15), `JOBS_SESSION_TTL_SECONDS` (7200), `JOBS_SESSION_MAX` (500) |
| `ai-service/tests/test_jobs_finder_search.py`, `ai-service/tests/test_jobs_finder_tracker.py` (new) | §16.2 |

### 12.3 Tools client (shared with the copilot)
Use the shared client PYTHON.md defines — expected `ai-service/app/tools_client.py`:
`async def execute_tool(meta_data: dict, tool: str, args: dict, *, confirmed: bool = False, timeout: float = 20.0) -> dict`
→ `POST {meta_data["tools_url"]}/execute`, header `Authorization: Bearer {meta_data["tool_token"]}`, JSON `{"tool", "args"}`
(`"confirmed": true` only when `confirmed`). Always returns a dict with `ok`: the 200 body as-is; missing `tools_url`/`tool_token` →
`{ok: False, error: "NO_TOOL_TOKEN", message}`; HTTP 401 → `{ok: False, error: "AUTH", message}`; timeout / network error →
`{ok: False, error: "UNAVAILABLE", message}`; non-JSON → `{ok: False, error: "INTERNAL", message}`. The token is never logged
or put in a message. The jobs-finder never sends `confirmed` (its tools need no confirmation). If PYTHON.md places the client
elsewhere, import it from there — the jobs-finder relies only on this signature and return contract.

### 12.4 Search arguments — `extract_search_args(text) -> SearchArgs(query, job_type, work_type, location)` (deterministic, no LLM)
1. `job_type`, first match in this order: `\bintern(ship)?s?\b` → `internship`; `\bpart[\s-]?time\b` → `part-time`;
   `\b(contract(ual)?|freelance)\b` → `contract`; `\b(full[\s-]?time|permanent)\b` → `full-time`.
2. `work_type`: `\b(remote|wfh|work\s+from\s+home)\b` → `remote`; `\bhybrid\b` → `hybrid`; `\b(on[\s-]?site|in[\s-]?office|wfo|work\s+from\s+office)\b` → `onsite`.
3. `location`: first `\b(?:in|at|near|around|based\s+in)\s+(<KNOWN_LOCATIONS alternation>)\b`; if none, the first standalone
   `\b(<KNOWN_LOCATIONS alternation>)\b` anywhere ("bangalore python jobs" → Bengaluru); canonicalised (bangalore → Bengaluru,
   gurgaon → Gurugram, bombay → Mumbai, madras → Chennai, calcutta → Kolkata, cochin → Kochi, trivandrum → Thiruvananthapuram,
   vizag → Visakhapatnam, mysore → Mysuru, new delhi / ncr / delhi ncr → Delhi). `KNOWN_LOCATIONS` = those names and aliases plus
   noida, hyderabad, pune, ahmedabad, jaipur, chandigarh, indore, coimbatore, lucknow, nagpur, bhubaneswar, surat, vadodara, bhopal,
   patna, goa, india, london, singapore, dubai, berlin, san francisco, new york, toronto, sydney. `india` → no location filter.
   Unknown places stay in the query ("jobs at Infosys" → query `infosys`; "jobs in data science" → query `data science`).
4. `query`: lowercase NFKC text minus the matched phrases, tokens `[a-z0-9+#.]+`, minus stopwords and known locations, ≤6 tokens,
   joined by spaces. Stopwords: `a an the me my i im we us you your can could would will please pls kindly help find search show get give
   list browse fetch look looking want need some any all few more other latest new newest recent fresh open current available good best top
   job jobs role roles position positions opening openings vacancy vacancies opportunity opportunities career careers listing listings
   posting postings work hiring hire for with of to in at on near around from by that which who are is there be as and or also just like
   related based something anything campus drive drives intern interns internship internships remote hybrid onsite full part time fulltime
   parttime contract freelance`.
   Examples (tested): "Can you help me find some Jobs" → `("", None, None, None)`; "find me software jobs in Bangalore" →
   `("software", None, None, "Bengaluru")`; "show remote data analyst internships" → `("data analyst", "internship", "remote", None)`;
   "python developer roles in pune or bangalore" → `("python developer", None, None, "Pune")`; "jobs at Infosys" → `("infosys", None, None, None)`.

### 12.5 Item shape (`data[i]` of `mode:jobparser:jobslist`) — `JobsListItem`
Legacy keys keep their spelling (the current `App.jsx` `aiMatchedJobs` mapping keeps working); every new key is snake_case.

| key | type | campus (`c` = a job in `jobs_search_campus` `data.jobs`) | external (`m` = PublicExternalJob) | crawl (`j` = crawler `Job`) |
|---|---|---|---|---|
| `id` | str, **stable** | `c.id` or `c._id` | `m.id` | `"crawl:" + sha1(normalize_url(application_url) or "title\|company\|location" lowercased)[:16]` |
| `kind` | `"campus"`\|`"external"` | `campus` | `external` | `external` |
| `source` / `sources` | str / [str] | `campus` / `["campus"]` | `m.sources[0]` / `m.sources` | `crawl` / `["crawl"]` |
| `title` | str | `c.title` | `m.title` | `j.title` |
| `company_name` | str | `c.company` if str, else `c.company.name`, else `c.companyName` | `m.company` | `j.company` |
| `company_logo` | str\|None | `c.companyLogo` | `m.companyLogo` | None |
| `location` | str | `c.location` | `m.location`, else `"Remote"` when remote | `j.location` |
| `job_type` | str | `c.employmentType` | `m.jobType` | `j.employment_type` |
| `work_type` | str\|None | `c.workType` | `m.workType` | None |
| `salary` | str | `c.salary` / `c.ctc` / `c.packageLpa` | `m.salary` | `j.salary`, else `j.stipend` |
| `experience` | str | `c.experience` | `m.experience` | `j.experience` |
| `job_domain` | str | `"Campus drive"` | `m.categories[0]` or `"Other"` | `j.category` |
| `skills` | [str] | `c.skills` | `[]` | `j.skills` |
| `description` | str ≤1200 chars | `c.description` | `m.description` | `j.description` |
| `requirements` | str | `" · ".join` of present: `Min CGPA x`, `Max backlogs n`, `Branches: …`, `Batch …`, selection process | `""` | `j.requirements` |
| `application_url` | str\|None | `c.applicationUrl` (None → in-portal apply) | `m.applyUrl` | `j.application_url` |
| `posted_at` / `deadline` | ISO\|None | `c.createdAt` / `c.applicationDeadline` or `c.deadline` | `m.postedAt` / None | None / None |
| `isEligible` | bool\|None | `c.isEligible` when the viewer is a student, else None | None | None |
| `eligibility_reasons` | [str] ≤3 | `c.eligibilityReasons` or `c.eligibility.reasons` | `[]` | `[]` |
| `min_cgpa` | float\|None | `c.minimumCgpa` or `c.minCgpa` | None | None |
| `match_score` | int 0–100\|None | `c.matchScore` | `m.matchScore` | None |
| `matched_skills` | [str] | `c.matchedSkills` | `m.matchedSkills` | `[]` |
| `application_status` | str\|None | `c.myApplication.status` or `c.applicationStatus` | `m.saved.status` | None |
| `saveable` | bool | False | True | False |
| `is_sample` | bool | False | `m.isSample` | False |

Missing string values become `"Not mentioned"` (legacy convention) except `application_url`, `company_logo`, `work_type`, dates → `None`.
Reading `c` is tolerant (any listed alternative key); PLACEMENTS.md should return the first-named keys.

### 12.6 Search flow (`run()` after URL / wishlist / applied / details intents)
1. Keep the irrelevant-prompt guard. Keep the job-keyword gate, extended with `drive`, `drives`, `opportunit`, `opening`, `vacanc`, `hiring`, `company`, `companies`.
2. `meta = req.meta_data or {}`; `role = (meta.get("actor") or {}).get("role") or req.user_role or "student"`. No `tool_token` → reply
   `Job search needs the backend connection, which isn't configured right now (AGENT_TOOL_SECRET is missing on the server). Please try again later.` — no items.
3. `args = extract_search_args(req.user_query)`. Yield the status line FIRST (the orchestrator only shows strings yielded before the first item):
   `🔎 Searching <scope> for “<query>”<facets>…\n\n`, or with an empty query `🔎 Finding the best matches for your profile in <scope><facets>…\n\n`;
   scope = `campus drives and the open-market job feed` (student) / `the open-market job feed` (others); facets = ` · internship · remote · Bengaluru`.
4. In parallel (`asyncio.gather`, timeout `JOBS_FINDER_TOOL_TIMEOUT_SECONDS`): students only — `jobs_search_campus {query?, location?, limit: JOBS_FINDER_CAMPUS_LIMIT}`;
   everyone — `jobs_search_market {query?, jobType?, workType?, location?, sort: "match" if student else "newest", limit: JOBS_FINDER_MAX_RESULTS}` (empty args omitted).
5. Failure handling (each note is yielded before any item): campus failed → `⚠️ Campus drives are unavailable right now (<message>); showing open-market jobs only.\n\n`;
   market failed → `⚠️ The open-market job feed is unavailable right now (<message>); showing campus drives only.\n\n`;
   both failed → `I couldn't reach the job database just now (<message>). Please try again in a moment.` and stop.
6. `merge_items`: campus items sorted `(isEligible is not True, -(match_score or -1), deadline or "9999")`, first `JOBS_FINDER_CAMPUS_LIMIT`;
   then market items in the order Node returned; dedupe by `id`; cap `JOBS_FINDER_MAX_RESULTS`.
7. No items → `I couldn't find any open roles matching “<query>”<facets> right now. Try fewer keywords, a different city, or say “show the latest internships”.`
   (the frontend keeps the previous list because `data` is empty).
8. Otherwise `session_job_store.replace_jobs(sid, items)` and yield each item as `{"type": "job_item", "job": item}` (the orchestrator's
   job-dict branch calls `format_job_for_data`, which returns the item unchanged). No LLM call happens anywhere in this flow.
The URL crawl path also calls `replace_jobs(sid, [crawl_item(job.model_dump()) for each verified job])`.

### 12.7 Markdown (`format_jobs_markdown(items, role, status_header)`)
- Student: `Hey there! I found <n> job(s) for you: <c> campus drive(s) (<e> you're eligible for) and <x> open-market listing(s), best matches first. Open the AI-matched tab to apply, or say “save job 2” to add one to your tracker.` (omit zero-count parts; crawl-only results: `I found <n> job(s) on that careers page.`).
- TPO/admin: `Hello Placement Team! I found <n> open-market listing(s) you could share with students or turn into campus drives.`

### 12.8 Wishlist, applied and details intents
- **Wishlist** (`_resolve_wishlist_intent`): returns `(False, None)` immediately unless the existing fast phrases / verb+noun / "wishlist" match
  (removes the Gemini call on every query). Target resolution, in order: ordinal/index → a unique cached item whose `company_name` (≥3 chars,
  not "Not mentioned") or `title` appears in the query → pronoun ("this job", "it", …) → last viewed → single cached item → shared Gemini
  client fallback (6 s) → otherwise ask which one (existing text).
- **Applied** (new, checked after wishlist): `\b(mark|set)\b[^.?!]{0,40}\bas\s+applied\b|\bi\s+(?:have\s+|'ve\s+|just\s+)?applied\b|\bapplied\s+(?:to|for)\b` with cached items; same target resolution.
- Action by target item:
  - `kind == "external"` and `saveable` → `execute_tool(meta, "market_job_save" | "market_job_mark_applied", {"job": item["id"]})`;
    ok → content = tool `summary`, `session_job_store.update_job(sid, id, application_status=<data.item.status>)`.
  - `kind == "campus"` → no tool call, `error: "CAMPUS_DRIVE"`; save → `“<title>” at <company> is a campus drive — campus drives are tracked in Applications, not the saved list. Say “apply to job <n>” to apply.`;
    applied → `“<title>” at <company> is a campus drive — apply in the portal (say “apply to job <n>”) and its status will appear under Applications.`
  - crawl item → no tool call; `That listing came from the careers page you shared and isn't in the job feed, so it can't be saved. Use its Apply link instead.`
  - no cached items → `There's no job list in this chat yet. Search first (e.g. “find data analyst internships”), then say “save job 2”.`
  - tool `ok: false` → `FORBIDDEN`: `Only students have a job tracker.`; `NOT_FOUND`: `That job is no longer in the feed.`;
    `AUTH`/`UNAVAILABLE`/`NO_TOOL_TOKEN`: `I couldn't reach your job tracker just now. Please try again.`; else the tool `message`.
- Emitted as `{"type": "add_wishlist", "header_message": "mode:jobparser:addjob:wishlist", "content": <text>, "data": WishlistResult}` with
  `WishlistResult = {"type": "wishlist", "action": "save"|"applied", "ok": bool, "job_id": str|None, "kind": str|None, "status": str|None,
  "error": None|"CAMPUS_DRIVE"|"NOT_SAVEABLE"|"NO_JOBS"|"AMBIGUOUS_TARGET"|<tool error code>, "ui": <tool ui>|None}`.
  The orchestrator then sends its final `isEnd` chunk with the same header and `data: []` (consumers key on `data.type == "wishlist"`).
- **Details**: unchanged flow and `data.selected_job` (now a §12.5 item); the prompt gains: "Use only facts present in Job Data. If a field is
  missing or 'Not mentioned', say so; never invent salary, skills, responsibilities, perks or links." The template fallback stays.

### 12.9 Routing fix ("add the 2nd job to my wishlist" must not reach job-creation)
- `JobFinderAgent.ROUTING_RULES.strong` += `\b(add|save|move|put|keep|bookmark|shortlist)\b[^.?!]{0,30}\b(wish\s*-?\s*list|saved(\s+jobs?)?|tracker|bookmarks?|favou?rites?)\b`
  and `\bmark\b[^.?!]{0,40}\bas\s+applied\b`.
- `JobCreationAgent.ROUTING_RULES.veto` += `\b(wish\s*-?\s*list|bookmarks?|shortlist(ed)?|favou?rites?|job\s+tracker|saved\s+jobs?)\b` and `\bas\s+applied\b`.

### 12.10 Wire example (final chunk; earlier chunks carry the growing list)
```json
{"requestId":"r-1","sessionId":"<browser session id>","header_message":"mode:jobparser:jobslist",
 "response":"🔎 Searching campus drives and the open-market job feed for “data analyst” · internship…\n\nHey there! I found 2 job(s) for you: 1 campus drive (1 you're eligible for) and 1 open-market listing, best matches first. …",
 "data":[
  {"id":"6743f0c2a1b2c3d4e5f60711","kind":"campus","source":"campus","sources":["campus"],"title":"Data Analyst Intern","company_name":"Acme Corp",
   "company_logo":null,"location":"Noida","job_type":"Internship","work_type":null,"salary":"₹30,000/month","experience":"Not mentioned",
   "job_domain":"Campus drive","skills":["SQL","Excel"],"description":"…","requirements":"Min CGPA 7 · Branches: CSE, IT · Batch 2026",
   "application_url":null,"posted_at":"2026-11-20T09:00:00.000Z","deadline":"2026-12-01T18:29:59.000Z","isEligible":true,
   "eligibility_reasons":[],"min_cgpa":7,"match_score":80,"matched_skills":["SQL"],"application_status":null,"saveable":false,"is_sample":false},
  {"id":"6743f0c2a1b2c3d4e5f60718","kind":"external","source":"debugwithshubham","sources":["debugwithshubham","whatsapp"],
   "title":"Data Analyst Intern","company_name":"Northwind Analytics","company_logo":null,"location":"Gurugram","job_type":"internship",
   "work_type":"hybrid","salary":"Not mentioned","experience":"Freshers","job_domain":"data-analyst","skills":[],"description":"…",
   "requirements":"","application_url":"https://example.com/jobs/123456","posted_at":"2026-11-24T08:00:00.000Z",
   "deadline":null,"isEligible":null,"eligibility_reasons":[],"min_cgpa":null,"match_score":72,"matched_skills":["SQL","Excel"],
   "application_status":"saved","saveable":true,"is_sample":false}],
 "isEnd":true}
```

---

## 13. Frontend consumers (informative — FRONTEND.md / UI-ACTIONS.md are authoritative for file names)
- API module `frontend/src/lib/api/jobFeed.js` (frontend:opportunities) over `lib/http.js`: `listMarketJobs(params)` → GET `/job-feed`,
  `getMarketJob(id)`, `listMarketCategories()`, `listMarketSources()`, `listSavedJobs(params)`, `saveMarketJob(jobId, {status, notes})` → PUT
  `/job-feed/saved/:jobId`, `removeSavedJob(jobId)`; TPO admin (frontend:tpo): `triggerJobFeedSync()` → POST `/job-feed/sync`,
  `getJobFeedSyncStatus()` → GET `/job-feed/sync/status`, live updates from socket `job-feed:sync`.
- Port `personal_project/frontend/src/components/jobs-list.jsx` (+ `services/jobs.js`) into the open-market panel: fix the L66 boolean
  render (show `via <source labels>`), render `categories`, `companyLogo`, `isSample` ("Sample listing" badge), add q / workType / location /
  source filters, Save / Applied actions (PUT tracker), "Tailor resume" → resume panel with `jobId`. `admin-sync-page.jsx` is not ported.
- Panels: `jobs.market` params `{q?, category?, jobType?, workType?, location?, source?, sort?, highlightIds?}`; `jobs.tracker`
  `{status?, highlightId?}`; `tpo.jobfeed` `{runId?}`.
- AI-matched tab (from `aiChat.latestJobs`): `_id = item.id`; badge CAMPUS vs OPEN MARKET (+ SAMPLE); FIT badge = `match_score` (hidden when
  null — no more hardcoded 100); eligibility badge only for `kind:"campus"` (`isEligible`, `min_cgpa`, `eligibility_reasons[0]`); apply:
  campus → placements in-portal apply with `item.id` unless `application_url`; external → open `application_url` and offer "Mark as applied"
  (PUT `status:"applied"`); Save shown when `saveable`. Header `mode:jobparser:addjob:wishlist` with `data.type === "wishlist"`: toast
  `response`, mark the card, apply `data.ui` when present. Non-student viewers must not be forced into student mode by `jobslist`.

---

## 14. Sample seed (demo, offline-friendly)

### 14.1 `sample-jobs.js`
`SAMPLE_EXTERNAL_JOBS` = the 16 raw inputs below; `seedSampleExternalJobs({now = new Date()} = {})` →
`jobSyncService.ingest("sample", inputs, now)` with `postedAt = now − hoursAgo` → `{inserted, existing}`; idempotent (dedupe keys).
Companies are fictional demo brands; every `applyUrl` is `https://example.com/careers/<slug>-<id>` (RFC 2606 reserved domain);
`externalId` = `sample-<id>`; each description is 2–3 sentences naming the listed skills and ends with
`(Sample listing — shown so the job feed is not empty during a demo.)`. All are stored `isSample:true`, source `sample`.

| id | title | company | location | jobType | workType | experience | salary | categories | skills in description | hoursAgo |
|---|---|---|---|---|---|---|---|---|---|---|
| 100001 | Software Engineer Intern | Contoso Labs | Bengaluru | internship | hybrid | Batch 2026/2027 | ₹40,000/month stipend | developer, engineer | Java, Spring Boot, SQL, Git | 6 |
| 100002 | Frontend Developer | Tailspin Software | Pune | full-time | onsite | 0-2 years | ₹6-9 LPA | developer | React, JavaScript, TypeScript, CSS | 20 |
| 100003 | Backend Developer (Node.js) | Wingtip Cloud | Remote | full-time | remote | 1-3 years | ₹8-12 LPA | developer, engineer | Node.js, Express, MongoDB, Docker | 30 |
| 100004 | Data Analyst Intern | Northwind Analytics | Gurugram | internship | hybrid | Freshers | ₹25,000/month stipend | data-analyst | SQL, Excel, Python, Power BI | 10 |
| 100005 | Machine Learning Engineer | Trey Research | Hyderabad | full-time | hybrid | 0-2 years | ₹12-18 LPA | engineer, research | Python, PyTorch, Machine Learning, NLP | 48 |
| 100006 | UI/UX Design Intern | Adventure Works Digital | Mumbai | internship | onsite | Freshers | ₹20,000/month stipend | design | Figma, UI/UX, Prototyping | 72 |
| 100007 | Cloud Support Associate | Litware Systems | Noida | full-time | onsite | 0-1 years | ₹5-7 LPA | operations, engineer | AWS, Linux, Networking | 96 |
| 100008 | Product Management Intern | Proseware Inc | Bengaluru | internship | hybrid | Batch 2026 | ₹35,000/month stipend | product | SQL, Jira, Product analytics | 120 |
| 100009 | Financial Analyst | Woodgrove Bank | Mumbai | full-time | onsite | 0-2 years | ₹7-10 LPA | finance, banking | Excel, Financial Modeling, Accounting | 150 |
| 100010 | Digital Marketing Associate | Fourth Coffee | Delhi | full-time | onsite | 0-1 years | ₹4-6 LPA | marketing | SEO, Google Analytics, Content | 170 |
| 100011 | QA Automation Engineer | Fabrikam Robotics | Chennai | full-time | onsite | 1-3 years | ₹6-10 LPA | engineer | Selenium, Java, CI/CD | 190 |
| 100012 | Full Stack Developer (6-month contract) | Lucerne Publishing | Remote | contract | remote | 1-2 years | ₹60,000/month | developer | React, Node.js, PostgreSQL | 200 |
| 100013 | HR Operations Intern | Wide World Importers | Pune | internship | onsite | Freshers | ₹15,000/month stipend | hr | Excel, Communication | 215 |
| 100014 | DevOps Engineer | Alpine Ski House | Hyderabad | full-time | hybrid | 2-4 years | ₹14-20 LPA | engineer | Docker, Kubernetes, AWS, Terraform | 230 |
| 100015 | Content Writer (Part-time) | Margie's Travel | Remote | part-time | remote | Freshers | ₹15,000/month | content | SEO, Writing | 238 |
| 100016 | Business Analyst | Coho Vineyard | Kolkata | full-time | onsite | 0-2 years | ₹6-8 LPA | consulting, data-analyst | SQL, Excel, Tableau | 239 |

### 14.2 Who seeds
The demo seed script (integrator) calls `seedSampleExternalJobs()` and may save 2 sample jobs for the demo student via
`upsertSavedJob` (one `saved`, one `applied`). The module never seeds by itself and the sync never invents jobs.

### 14.3 Automatic cleanup
After every run whose status is not `failed`, if `ExternalJob.exists({isSample:false})`: delete sample jobs whose `_id` is not in
`SavedJob.distinct("job")`; the count goes to `run.sampleJobsRemoved`. A failed (offline) run never touches samples; samples are
excluded from the retention purge and from the match digest.

---

## 15. Environment variables (`config.js` → `getJobFeedConfig()`, read at call time)

| name | default | meaning |
|---|---|---|
| `JOB_SYNC_INTERVAL_MINUTES` | `60` | periodic sync interval; integer 0–10080, invalid → 60; `0` disables the periodic sync |
| `JOB_SYNC_ON_BOOT` | `true` | `false` skips the boot sync (which also only runs when the last successful sync is older than the interval, or 60 min when the interval is 0) |
| `ADMIN_SYNC_SECRET` | empty | when set, header `x-admin-sync-secret` authorises `POST /api/v1/job-feed/sync` for cron jobs; never shipped to the frontend |
| `FROM_ARTHA` | `false` | `true` adds the artha.link source |
| `ARTHA_KEYWORDS` | empty | comma list of artha searches/categories; empty → the 25 built-in keywords |
| `ARTHA_LOCATION` | `IN` | country the artha API searches |
| `ARTHA_COUNTRIES` | empty | comma list of country codes to keep (e.g. `IN`); empty keeps all |
| `JOB_FEED_RETENTION_DAYS` | `45` | delete non-sample, unsaved jobs not seen for N days (daily job); integer 0–3650, invalid → 45; `0` disables |
| `JOB_FEED_MATCH_DIGEST` | `true` | `false` disables the daily `jobfeed.matches` notification |
| `WHATSAPP_ENABLED` | `false` | `true` runs the WhatsApp listener inside the API (requires `baileys` + `TOKEN_ENCRYPTION_KEY`) |
| `WHATSAPP_CHANNELS` | empty | channel links, invite codes, `<digits>@newsletter` ids, or `all` |
| `WHATSAPP_LLM_EMAIL` | empty | TPO/admin account whose BYOK key reads posts; empty → the only TPO/admin with a key |
| `WHATSAPP_LLM_PROVIDER` | empty | `openai`, `anthropic`, `google` or `xai` when that account has several keys |
| `WHATSAPP_LLM_MODEL` | empty | model override for extraction |
| `WHATSAPP_PAIRING_NUMBER` | empty | link with an 8-character pairing code instead of the terminal QR |

Also used (owned elsewhere): `TOKEN_ENCRYPTION_KEY` (WhatsApp auth state), `LLM_CREDENTIAL_ENCRYPTION_KEY` (BYOK), `APP_TIMEZONE`.
Python (`ai-service/app/config.py`): `JOBS_FINDER_MAX_RESULTS` 12, `JOBS_FINDER_CAMPUS_LIMIT` 6, `JOBS_FINDER_TOOL_TIMEOUT_SECONDS` 15,
`JOBS_SESSION_TTL_SECONDS` 7200, `JOBS_SESSION_MAX` 500.

---

## 16. Acceptance tests

### 16.1 Backend (`cd "/Users/sanyampandey/Minor Project /backend" && NODE_ENV=test node --test test/job-feed-*.test.js`)
Import `./helpers.js` first; `connectTestDb("job_feed_…")`. **No network:** sources get `fetchImpl` stubs; each file replaces
`globalThis.fetch` with a function that throws `network disabled in tests` (restore in `after`); `jobSyncService.sources` is set to fakes.

`job-feed-sync.test.js`
1. Normalizer (ported): messy values cleaned (`𝗦𝗗𝗘-𝟭` → `SDE-1`, `FullTime` → `full-time`, "Work from home" → `remote`, `:https://…?` repaired); unusable inputs → null; future `postedAt` → `seenAt`; `cleanUrl` cases; dedupe keys (tracking params ignored, different job ids differ, careers page/shortener need same title, no-link company suffixes ignored, `source:` fallback).
2. Syncing the same feed twice → `[2,0,null]` then `[0,2,null]`, 2 docs, IST `posted_at` → `2026-09-22T13:36:00.000Z`.
3. Reposts merge into one job keeping the newest `postedAt` and all `sources.externalId`s.
4. Same job from two sources → one doc, `sources` `["debugwithshubham","whatsapp"]`.
5. Failing source keeps its first batch and the next source still runs; run `status:"partial"`.
6. Concurrent `sync()` calls → `fetchBatches` runs once and both promises resolve to the same object.
7. DebugWithShubham paging requests exactly `["FullTime:1:200","FullTime:2:200","Internship:1:200","Contract:1:200"]`.
8. artha: keyword paging, categories via matcher (ABAP developer not `legal`), location/salary/experience/description formatting, `ARTHA_COUNTRIES=IN` keeps only Indian jobs.
9. The unique index refuses a second doc with the same `dedupeKey` (`code 11000`).
10. Backfill: job first ingested without description/location, then from another source with them → both stored; a later different description does NOT overwrite.
11. **Offline:** every source throws → resolves (no throw), `status:"failed"`, per-source errors, job count and sample count unchanged, a `JobSyncRun` with `status:"failed"` persisted.
12. Samples: `seedSampleExternalJobs()` inserts 16 (`isSample:true`, sources `["sample"]`), second call inserts 0; a successful run with real jobs removes unsaved samples (`sampleJobsRemoved` = 15 when one sample is saved) and keeps the saved one; a failed run removes none.
13. `shouldRunBootSync`, `getJobFeedConfig` (interval `"abc"` → 60, `"0"` → 0, `"20000"` → 60; retention parsing; booleans), `markInterruptedRuns`, `purgeStaleJobs` (old unsaved deleted; saved and sample kept).
14. Notifications (needs the notifications module): a student with skill `react` gets exactly one `jobfeed.matches` after a run inserting a fresh "React Developer" job; a second run the same day adds none; a student without skills gets none; sample seeding never notifies. A TPO gets one `jobfeed.sync.failed` after a failed run; a second failed run adds none.

`job-feed-api.test.js`
15. 401 without a token on `GET /`, `/categories`, `/sources`, `/saved`, `/:id`, and on `POST /sync` without token or header.
16. List newest first with paging (`limit=2` → 2 items, `total`, `hasNextPage`); public keys exactly §7.1 (without `matchScore` for `sort=newest`); `jobType=FullTime` accepted, `jobType=banana` → 400 `VALIDATION` `field:"jobType"`; `workType`; `category=Developer` (case-insensitive); `source=whatsapp`; `location=Bangalore` finds `Bengaluru`; `q` is AND across tokens and matches description; `q=c++` does not throw; `sort=match` for a student with skills ranks the matching job first and returns `matchScore`; `sort=foo` → 400.
17. `/categories` counts and order; `/sources` lists the 4 sources with counts and `enabled` flags.
18. `GET /:id` → 200 with `saved` state for the owner; 400 bad id; 404 unknown id.
19. Tracker: PUT creates (201, snapshot, `history` length 1), PUT `{status:"applied"}` → 200 with `appliedAt`, back to `saved` clears it; `GET /saved` items + `counts`; another student sees none of it; DELETE → `{deleted:true}`, again → 404; PUT unknown job → 404; invalid status / notes >2000 → 400; teacher → 403; after the job is purged the entry lists with `jobAvailable:false` and the snapshot.
20. Sync: student/teacher → 403; tpo → 202 `{run:{status:"running"}, alreadyRunning:false}` and a persisted run; admin → 202; `?wait=true` → 200 with a finished run; valid `x-admin-sync-secret` (env set) → 202 with `trigger:"cron"`; wrong secret or env unset → 401 `INVALID_SYNC_SECRET`; `GET /sync/status` tpo → 200 §7.5 shape, student → 403.

`job-feed-tools.test.js`
21. Exactly 4 tools with the names, roles, `confirm` flags of §10 and object parameter schemas.
22. `jobs_search_market` handler: ranked `data.jobs`, `ui.panel:"jobs.market"` with `highlightIds`, summary lists top results; zero results summary.
23. `market_job_save`: by id creates; by "Title at Company" resolves; ambiguous → `{ambiguous:true, candidates ≤5}`; unknown → ApiError 404 `NOT_FOUND`; second save → "already in your tracker"; `market_job_mark_applied` sets `applied` + `appliedAt`; when `interviewing` → unchanged.
24. `job_feed_sync`: `preview` text; handler with fake sources returns a finished summary with counts.
25. Through `POST /api/v1/agent-tools/execute` (`agentToolToken`): `jobs_search_market` → `ok:true`; `market_job_save` as a teacher → `FORBIDDEN`; `job_feed_sync` without `confirmed` → `needs_confirmation:true`, with `confirmed:true` → `ok:true`.

`job-feed-whatsapp.test.js` (ported from Matchy `whatsapp.test.js`, no network, fake LLM clients)
26. `parseChannelList`; `toChannelPost` (skip when `loadBaileys()` is null); `findUrls` / `looksLikeJobPost`; `expandUrl` only follows shorteners; `extractWithRules`; `parseLlmJobs` keeps only URLs from the post; extractor asks the LLM only for likely posts; temporary errors retried, permanent not.
27. `WhatsAppPostService`: a post becomes jobs once; an already-saved job gains source `whatsapp`; failed then retried clears `error`; non-job posts `ignored`; `retryFailed` respects the 3-day window and attempt cap.
28. `loadLlmClient` with an injected `importByok` fake: uses a TPO's key; ignores students' keys; non-TPO email → reason; provider/model overrides; import failure → `the BYOK module is not available`.
29. Auth state: stored values are encrypted (no raw `noiseKey` text in the collection), survive a "restart" with Buffers intact, `clearMongoAuthState` empties it, an undecryptable value is treated as missing (skip when `loadBaileys()` is null).
30. `startWhatsAppListener({importBaileys: () => Promise.reject(new Error("Cannot find package 'baileys'"))})` resolves and `getWhatsAppStatus().state === "unavailable"`; `import("../src/app.js")` never loads `baileys` (no static import anywhere: grep-style assertion over `src/` files).

### 16.2 Python (`cd ai-service && .venv/bin/python -m pytest -q tests/test_jobs_finder_search.py tests/test_jobs_finder_tracker.py`)
Fake `execute_tool` (monkeypatched in the job_finder module namespace), the shared Gemini client patched to raise, and a fake
`sio` collecting `emit` calls while running `orchestrator.handle()` with `mode_name="jobs-finder"`.
1. A search emits `mode:jobparser:jobslist` chunks whose final `data` items have exactly the §12.5 keys; campus first, ids equal the tool ids, `isEligible` set for campus and `None` for external; the Gemini client is never called.
2. `extract_search_args` examples of §12.4.
3. No `tool_token` → the configuration message, no items, no tool call.
4. Campus tool fails → note + market items; both fail → error message and `data: []`; zero results → the no-results message.
5. Non-student actor → only `jobs_search_market` is called, with `sort:"newest"`.
6. A second search replaces the cached list; "save job 1" then targets the new first item.
7. "add the 2nd job to my wishlist" → `market_job_save` with `{"job": <2nd id>}`, header `mode:jobparser:addjob:wishlist`, `data.type == "wishlist"`, `ok` true; a campus target → no tool call, `error: "CAMPUS_DRIVE"`; a crawl target → `error: "NOT_SAVEABLE"`; "mark job 1 as applied" → `market_job_mark_applied`.
8. `route_query("add the 2nd job to my wishlist")` → `jobs-finder`; `route_query("post a job for Infosys")` → still `job-creation`.
9. `format_job_for_data(Job(...).model_dump())` → crawl item (`id` starts with `crawl:`, `kind:"external"`, `saveable: False`); `format_job_for_data(item)` returns the item unchanged.

---

## 17. Cross-module interfaces
- **Exports of job-feed** (stable paths): `feed.service.js` → `getExternalJob(id) → PublicExternalJob|null`, `toPublicJob`, `resolveMarketJob`,
  `searchMarketJobs`; `tracker.service.js` → `upsertSavedJob({user, jobId, status?, notes?})`; `sample-jobs.js` → `seedSampleExternalJobs`;
  `models/external-job.model.js` → `ExternalJob`, `models/saved-job.model.js` → `SavedJob`; `normalizer.js` → `normalizeJobType`, `normalizeWorkType`.
- **AGENT-TOOLS.md §5**: `jobs_search_market` gains optional `workType`, `location`, `sort`.
- **UI-ACTIONS.md**: panels `jobs.market`, `jobs.tracker`, `tpo.jobfeed` with the params of §13.
- **NOTIFICATIONS.md**: new types `jobfeed.matches`, `jobfeed.sync.failed`.
- **PLACEMENTS.md**: `jobs_search_campus` returns `data.jobs[]` with `id, title, company ({id,name} or string), location, salary, employmentType, skills,
  description, applicationDeadline, minimumCgpa, maximumBacklogs, eligibleBranches, graduationYears, selectionProcess, isEligible, eligibilityReasons,
  matchScore, matchedSkills, myApplication ({status}|null), applicationUrl, createdAt`; the in-portal apply endpoint takes that `id`.
- **RESUME-BYOK.md**: `backend/src/modules/byok/index.js` named exports `decryptApiKey(encrypted)` and `GenericLlmClient(provider, apiKey, model)`
  (`complete(messages) → {content}`, errors carry `statusCode`); external JDs come from `getExternalJob(id)`; never write to `ExternalJob`.
- **PYTHON.md**: shared `execute_tool` client (§12.3) and shared Gemini client; jobs-finder work of §12 assigned to python:agent-fixes; the
  §12.9 routing rules must survive the role-aware router.
- **FRONTEND.md**: §13 consumers.
