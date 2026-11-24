# Contract — Resume Lab (unified resumes · LaTeX · ATS) and BYOK LLM tailoring

Owner modules:
- `backend/src/modules/resume-lab/` owns resumes, file storage, text extraction, the LaTeX compiler, the ATS scorer, job references and the SIH-compatible routes.
- `backend/src/modules/byok/` owns bring-your-own-key credentials, the provider client and surgical tailoring.

Dependency direction: `byok` may import `resume-lab` services, but `resume-lab` never imports `byok`.

Conventions:
- Every JSON route uses the existing envelope through `core/http.js` (`send`, `fail`, `requireAuth`, `requireRole`, `assertObjectId`, `intParam`, `escapeRegex`, `asyncHandler`).
  - success: `{statusCode, data, message, success:true}`
  - failure: `{success:false, message, errors:[{code, …}], data:null}`
- The UI branches only on `errors[0].code`. Codes are listed in §8.0.
- Binary responses (PDF/DOCX/TEX bytes) are the only exception to the envelope. Their errors are still JSON envelopes.
- Stack: Express 5, Mongoose 9, ESM, Node ≥ 22.

Sources to port (paths relative to `/Users/sanyampandey/personal_project/backend/` = MBE, and to the merged `backend/` = BE):

| Source | Destination | What changes |
|---|---|---|
| MBE `src/models/resume.model.js`, BE `src/models/resume.models.js` | `resume-lab/models/resume.model.js` | merged into one schema (§2.1) |
| MBE `src/repositories/resume.repository.js`, `src/controllers/resume.controller.js` | `resume-lab/services/resume.service.js` + `routes/resumes.routes.js` | envelope, kinds, versions, primary, lock |
| MBE `src/services/resume-storage.service.js` | `resume-lab/storage/uploadthing.driver.js` | private ACL, signed reads (§3) |
| BE `src/services/resume-bank.service.js` (Cloudinary part) | `resume-lab/storage/cloudinary.driver.js` | driver interface |
| MBE `src/services/latex-compiler.service.js` | `resume-lab/latex/{compiler,normalize,policy}.js` | source policy, queue, timeout fix, pdfTeX shim (§6) |
| MBE `scripts/install-tectonic.js` | `backend/scripts/install-tectonic.js` | same logic |
| BE `src/routes/resume-bank.routes.js` | `resume-lab/routes/bank.routes.js` | same paths and shapes |
| MBE `src/config/llm.js` + `src/config/constants.js` | `byok/providers.js` | Anthropic default model and normalization (§9.1) |
| MBE `src/services/llm-credentials.service.js` | `byok/services/credentials.service.js` | `keyHint`, `isByokEnabled()` |
| MBE `src/services/llm.service.js` | `byok/services/llm-client.js` | stop-reason checks, headers, timeouts, pagination (§9.3) |
| MBE `src/controllers/llm.controller.js` (`callLlm`) | `byok/services/tailor.service.js` + `resume-lab/services/patches.js` | per-user JDs, campus and market jobs, patch fixes (§9.5) |

## 0. Decisions at a glance

1. **One `Resume` model in the `resumes` collection** replaces both the SIH Resume Bank and the Matchy catalog.
   - Editable text (LaTeX, or plain text) lives in MongoDB (`source`).
   - Only binaries go through the storage adapter: uploaded PDF/DOCX files and cached compiled PDFs.
2. **Every resume is a numbered version.** `version` is a per-owner sequence, following SIH semantics.
   - Editing changes a resume in place and increments `revision`.
   - A locked resume (shared with an alumnus, or attached to an application) cannot change. Use "duplicate" or "save tailoring as a new version" instead.
3. **Exactly one `isPrimary` resume per student.** It is the default for scoring, tailoring, drive applications and the copilot.
4. **Tectonic replaces `latexonline.cc` everywhere**, including the generator preview.
   - I verified on this machine that `tectonic --untrusted` still reads arbitrary files through `\input{/abs/path}`, `^^5cinput`, `\csname input\endcsname`, `\openin`/`\read` and `../` paths.
   - So a source policy, a secret scan and a minimal environment are **mandatory** (§6.3).
5. **The ATS score is deterministic Node code** with an explainable breakdown, and no LLM is involved.
   - The Python resume agent's LLM analysis (`ResumeAnalysisPanel`) stays as it is.
6. **Tailoring is paid only by the student's own key (BYOK).** There is no server fallback key (see open question 1).
   - Manual job descriptions are stored per (user, job) and are **never** written to shared job documents.
7. **Jobs are referenced by `jobId` plus `jobSource: "campus"|"market"`**, the UI-ACTIONS canonical param names.
   - `campus` is the placements `Job` model; `market` is `ExternalJob` (JOB-FEED.md).
   - Inputs also accept `"external"` (JOB-FEED's `PublicExternalJob.kind`) as an alias of `"market"`, and `jobKind` as an alias param name.
   - Job objects in responses are `{source, id, title, company}`, where `source` takes the same values as `jobSource`.
8. **Legacy paths keep their shapes:** `/api/v1/resume-bank/*`, `POST /api/v1/resume/upload` and `GET /api/v1/resume/score`.
   - For the score, the **frontend** changes: `App.jsx` stores `.data` (§18). The backend keeps the standard envelope.

## 1. Files

**Create (backend):**
```
backend/src/modules/resume-lab/
  index.js                      default export (§14): mounts, start(), tools
  config.js                     env getters (read lazily, see §15)
  models/resume.model.js        §2.1
  models/job-description-override.model.js   §2.2
  routes/resumes.routes.js      /api/v1/resumes/*         (§8.3)
  routes/legacy.routes.js       /api/v1/resume/*          (§8.1)
  routes/bank.routes.js         /api/v1/resume-bank/*     (§8.2)
  services/resume.service.js    CRUD, versions, primary, lock, serializers, compat exports (§2.5, §13)
  services/upload.service.js    multer, type sniffing, create-from-upload (§4)
  services/extract.service.js   pdf/docx/tex/txt → text, latexToText (§4)
  services/access.service.js    signed links, file streaming (§8.4)
  services/job-ref.service.js   resolveJob, resolveJobRef, resolveJobDescription, overrides (§7)
  services/patches.js           pure patch helpers, also used by byok (§9.5, §8.3)
  services/migrate.service.js   legacy SIH migration and index sync (§2.4)
  storage/index.js, storage/local.driver.js, storage/cloudinary.driver.js, storage/uploadthing.driver.js (§3)
  latex/compiler.js, latex/normalize.js, latex/policy.js (§6)
  ats/scorer.js, ats/text.js, ats/lexicon.js (§5)
  tools.js                      resume_list, resume_score (§12)
backend/src/modules/byok/
  index.js, config.js (env getters), providers.js, routes.js
  services/credentials.service.js, services/llm-client.js, services/tailor.service.js
  tools.js                      resume_tailor_for_job (§12)
backend/scripts/install-tectonic.js     port of MBE scripts/install-tectonic.js (postinstall; Linux only)
backend/scripts/migrate-resumes.js      CLI wrapper of migrate.service.js
backend/test/{resume-lab,ats,latex,byok}.test.js
backend/test/fixtures/resume-sample.{tex,pdf,docx}   (pdf compiled from the .tex with Tectonic; docx from any word processor; each ≤ 30 KB)
```

**Modify:**
- `backend/src/app.js`: remove `import resume_bank_router …` and `app.use("/api/v1/resume-bank", …)`. The module mounts it now.
- `backend/src/models/resume.models.js`: its whole body becomes `export { Resume } from "../modules/resume-lab/models/resume.model.js";`.
- `backend/src/services/resume-bank.service.js`: its whole body becomes re-exports of `listResumeMetadata`, `getLatestResumeForAnalysis` and `saveGeneratedResume` from `../modules/resume-lab/services/resume.service.js`. `metadata-builder.js` keeps importing it unchanged. All `latexonline.cc` and Cloudinary code is removed.
- `backend/src/routes/alumni.routes.js`: the share-resume changes in §13.
- `backend/src/models/user.models.js`: add `keyHint: {type: String, maxlength: 40}` to the `llmCredentials[]` sub-schema.
- `backend/package.json`: add the scripts `"postinstall": "node scripts/install-tectonic.js"` and `"migrate:resumes": "node scripts/migrate-resumes.js"`. No new dependencies: `multer`, `unpdf`, `mammoth`, `uploadthing` and `cloudinary` are already installed. **Do not add `@anthropic-ai/sdk`.**
- `backend/.gitignore`: add `uploads/` and `bin/`.
- `backend/.env.example`: create it if missing and append the §15 variables (names and defaults only, no secrets).

**Delete:** `backend/src/routes/resume-bank.routes.js`.

**Frontend:** see §18. **Python:** no changes are required (see §20.8).

## 2. Data model

### 2.1 `Resume` (collection `resumes`, model name `"Resume"`, `{timestamps:true}`)

Register the model as `mongoose.model("Resume", schema)` with **no** `mongoose.models.Resume ||` guard. Nothing else may register `"Resume"`.

| field | type | notes |
|---|---|---|
| owner | ObjectId→User, required, index | the student |
| createdBy | ObjectId→Student | legacy SIH; set when `user.student` exists; never required |
| title | String, required, trim, 1–200 | control characters stripped |
| kind | enum `latex`\|`pdf`\|`docx`\|`text`, required, default `latex` | the default only matters for legacy docs |
| origin | enum `generated`\|`uploaded`\|`created`\|`tailored`\|`duplicated`, default `generated` | |
| status | enum `active`\|`archived`, default `active` | |
| archivedAt | Date | |
| version | Number, required, min 1 | per-owner sequence shown as "Version N"; `max(version)+1` at creation, retried up to 3 times on E11000 |
| revision | Number, default 1 | incremented on every `source` change |
| isPrimary | Boolean, default false | at most one per owner; never true while archived |
| source | String, `select:false` | LaTeX (kind `latex`) or plain text (kind `text`); absent for pdf/docx; ≤ `RESUME_MAX_SOURCE_BYTES` UTF-8 bytes; CRLF normalized to LF on write |
| extractedText | String, `select:false`, ≤ 100 000 chars | plain text for scoring and tailoring (§4) |
| sourceHash | String, required | sha256 hex of `source` (latex/text) or of the original bytes (pdf/docx) |
| dedupeKey | String | set **only** for `origin: generated`: `sha256(JSON.stringify({latexCode: source.trim(), targetJob: targetJob \|\| null}))`, byte-identical to SIH's `hashResume` (keep `\|\|`, not `??`); never changes |
| original | StoredFile | the uploaded binary (pdf/docx only) |
| pdf | StoredFile + `{sourceHash: String, compiledAt: Date}` | cached compiled PDF (latex only); stale when `pdf.sourceHash !== sourceHash` |
| targetJob | Mixed, default null | ≤ 16 KB as JSON (else 400). Tailored versions store `{source, id, title, company, roleTitle: title, companyName: company}` (Python reads `companyName`) |
| parent | ObjectId→Resume, default null | the duplicated or tailored base |
| lockedAt | Date, default null | set by `lockResume()`; `source` is immutable afterwards |
| lockReasons | [enum `alumni-share`\|`application`\|`manual`] | |
| ats | `{score: Number, grade: String, sourceHash: String, scorerVersion: String, computedAt: Date}` | last generic (no-job) score; list badge only |
| meta | `{pages: Number\|null, words: Number, chars: Number, truncated: Boolean, extractionWarning: String\|null}` | |
| storage | Mixed | legacy SIH Cloudinary record; read only by the migration, then `$unset` |

`StoredFile` (`_id:false`): `{driver: enum local|cloudinary|uploadthing (required), key: String (required), contentType: String, bytes: Number, sha256: String, originalName: String, meta: Mixed}`.

**Indexes:**
- `{owner:1, version:1}` unique.
- `{owner:1, dedupeKey:1}` unique, with `partialFilterExpression: {dedupeKey: {$type: "string"}}`.
- `{owner:1}` unique, with `partialFilterExpression: {isPrimary: true}`, name `owner_primary_unique`.
- `{owner:1, status:1, updatedAt:-1}`.
- `{owner:1, "original.sha256":1}`.

The legacy SIH unique index `owner_1_sourceHash_1` **must be dropped** (§2.4). Otherwise duplicating a resume, or two resumes with identical content, throws E11000.

**Invariants (enforced in `resume.service.js`):**
- Changing `source` requires `kind ∈ {latex, text}` (else `409 NOT_EDITABLE`), `lockedAt == null` (else `409 RESUME_LOCKED`) and `status: active` (else `409 RESUME_ARCHIVED`).
- On every `source` change: recompute `extractedText`, `sourceHash`, `meta` and `ats`, and increment `revision`. A cached `pdf` becomes stale automatically.
- **Promotion rule:** when an owner has active resumes but no primary (first create, archive, delete), the most recently `updatedAt` active resume becomes primary.
- **Setting primary:** run `updateMany({owner, isPrimary:true, _id:{$ne:id}}, {$set:{isPrimary:false}})`, then set the target. On E11000, retry once. No transactions are used, because MongoDB may run standalone.
- The limit is `RESUME_MAX_PER_USER` **active** resumes per owner (`409 RESUME_LIMIT`).

### 2.2 `JobDescriptionOverride` (collection `job_description_overrides`)

This is the per-user replacement for Matchy writing pasted JDs into the shared `Job.description`.

| field | type | notes |
|---|---|---|
| user | ObjectId→User, required | |
| jobSource | enum `campus`\|`market`, required | |
| jobId | ObjectId, required | `Job._id` or `ExternalJob._id` |
| text | String, required, 30–20 000 chars | trimmed |
| textHash | String | sha256 hex |
| timestamps | | |

**Indexes:**
- `{user:1, jobSource:1, jobId:1}` unique.
- TTL `{updatedAt:1}`, `expireAfterSeconds: 15552000` (180 days).

### 2.3 `User.llmCredentials` (existing, `select:false`)

Shape: `[{_id, label ≤80, provider: openai|anthropic|google|xai, encryptedApiKey, model, keyHint (new), updatedAt}]`. `toJSON` already strips it.

- `verifyJWT` does **not** load this field. Every BYOK read re-queries `User.findById(id).select("+llmCredentials")`.
- Writes are atomic `updateOne` calls with `$push`, `$pull` or positional `$set` together with `$elemMatch`. **Never `req.user.save()`.**
- `keyHint` is `maskApiKey(apiKey)`, computed when the key is saved. Legacy entries without a hint are decrypted once and backfilled.

### 2.4 Legacy SIH migration (`migrateLegacyResumes()` in `services/migrate.service.js`)

`start()` runs it at boot. `npm run migrate:resumes` runs the same function. It is idempotent and only touches docs without `kind`, or with `storage` or `latexCode` set.

For each such doc (read with `.lean()` / raw collection):
1. `$rename latexCode → source`.
2. Set:
   - `kind: "latex"`, `origin: "generated"`, `revision: 1`, `isPrimary: false`
   - `dedupeKey` = the legacy `sourceHash` (unchanged value)
   - `sourceHash` = sha256 of the LF-normalized source
   - `extractedText` = `latexToText(source)`, plus `meta`
3. Move `storage` to `pdf`: `{driver:"cloudinary", key: storage.publicId, contentType:"application/pdf", bytes: storage.bytes, meta:{resourceType, deliveryType, format, assetId}, sourceHash: <new sourceHash>, compiledAt: doc.createdAt}`. Then `$unset storage`.
4. If any `MentorshipMessage{type:"resume-share", resumeVersion: _id}` exists, set `lockedAt = earliest share createdAt` and `lockReasons = ["alumni-share"]`.

After the docs, per owner: if no active primary exists, mark the highest-`version` active resume as primary.

Finally:
- Drop the index `owner_1_sourceHash_1` if it exists (ignore "index not found").
- Run `Resume.syncIndexes()`.
- Log `{migrated, locked, primaries}` counts.

A second run changes nothing.

### 2.5 Response shapes (serializers in `resume.service.js`)

```
ResumeSummary = {
  _id, id,                       // both: SIH code reads _id, ported Matchy code reads id
  title, kind, origin, status, version, revision,
  isPrimary, locked: Boolean(lockedAt), editable: kind∈{latex,text} && !locked && status==="active",
  hasPdf: kind==="pdf" || kind==="latex",
  sizeBytes,                     // source bytes (latex/text) or original.bytes (pdf/docx)
  contentType,                   // application/x-tex | text/plain | application/pdf | application/vnd.openxmlformats-officedocument.wordprocessingml.document
  targetJob, parentId,
  atsScore,                      // ats.score when ats.sourceHash === sourceHash, else null
  extractionWarning,             // meta.extractionWarning
  storage: { bytes },            // SIH compat (= sizeBytes)
  createdAt, updatedAt }
ResumeDetail = ResumeSummary + { meta: {pages, words, chars, truncated} }
BankItem = { _id, title, version, targetJob, status, kind, isPrimary, createdAt, updatedAt, storage: { bytes } }
```

Never serialized: `source`, `extractedText` (except as `content` in `GET /resumes/:id`), `sourceHash`, `dedupeKey`, `original.key`, `pdf.key`, `storage`, `createdBy`.

## 3. Storage adapter (`resume-lab/storage/`)

```js
// storage/index.js
getStorage(driverName = config.storageDriver)   // "local" (default) | "cloudinary" | "uploadthing"
// each driver:
{ name,
  isConfigured(): boolean,
  put(key, buffer, { contentType, originalName }) → StoredFile,   // StoredFile.driver = name
  get(storedFile) → Buffer,
  delete(storedFile) → void,                                       // idempotent; never throws on "not found"
  signedUrl?(storedFile, { expiresInSeconds, download, filename }) → string }   // remote drivers only
```

- **New files** use `STORAGE_DRIVER`. **Existing files** are always read with the driver recorded in `StoredFile.driver`, so legacy Cloudinary PDFs stay readable after switching to local.
  - An unconfigured driver gives `503 STORAGE_UNAVAILABLE`.
  - Unknown `STORAGE_DRIVER` values fall back to `local` with one warning.
- **Key format:**
  - uploads: `resumes/<ownerId>/<randomUUID>.<pdf|docx>`
  - compiled PDFs: `resumes/<ownerId>/<resumeId>-r<revision>-<sourceHash[0..12]>.pdf`
- **local:**
  - Root is `path.resolve(UPLOAD_DIR)`. Create directories with `recursive:true` and files with mode `0o600`.
  - **Path guard:** a resolved path must stay inside the root, else `fail(400, …, "VALIDATION")`.
  - No `signedUrl`. Files are streamed by Node.
- **cloudinary** (port of the SIH code):
  - Upload with `upload_stream({resource_type: pdf ? "image" : "raw", type: "authenticated", public_id: "<CLOUDINARY_RESUME_FOLDER>/<ownerId>/<uuid>", format?: "pdf", overwrite:false})`.
  - `signedUrl` is `cloudinary.utils.private_download_url(publicId, format, {resource_type, type, expires_at, attachment: download})`.
  - `get` fetches a 60-second signed URL.
  - `delete` is `uploader.destroy(publicId, {resource_type, type})`.
- **uploadthing** (port of MBE `UploadThingResumeStorage`):
  - Construct `new UTApi({token: UPLOADTHING_TOKEN})` lazily.
  - Upload with `uploadFiles(new UTFile([buffer], name, {type}), {acl: UPLOADTHING_ACL})` and store `data.key`.
  - `signedUrl` and `get` use `generateSignedURL(key, {expiresIn})` → `ufsUrl`. **Never** build `https://utfs.io/f/<key>` (public legacy host).
  - `delete` is `deleteFiles(key)`.
- **Hard delete** removes the DB doc first, then deletes `original` and `pdf` best-effort. Failures are logged as `[resume-lab] orphaned file <driver>:<key>`, never surfaced to the user.

## 4. Upload, type detection and text extraction

**multer config:**
- `memoryStorage()`.
- `limits: {fileSize: RESUME_MAX_UPLOAD_BYTES, files: 1, fields: 10, fieldSize: RESUME_MAX_SOURCE_BYTES + 1024}`.
- Accepted file fields: `resume` (legacy) or `file`, via `upload.fields([{name:"resume",maxCount:1},{name:"file",maxCount:1}])`.
- Wrap multer so its errors are mapped:
  - `LIMIT_FILE_SIZE` → `413 FILE_TOO_LARGE`
  - other `MulterError`s and malformed multipart → `400 VALIDATION`
  - The app's generic handler would otherwise answer 500.

**Type sniffing** (by content, not by name or MIME):

| detected kind | rule | extraction |
|---|---|---|
| `pdf` | starts with `%PDF-` | `unpdf`: `const doc = await getDocumentProxy(new Uint8Array(buf)); const {totalPages, text} = await extractText(doc, {mergePages: true})` → `meta.pages = totalPages` |
| `docx` | starts with `PK\x03\x04` and `mammoth` parses it | `mammoth.convertToHtml({buffer})`, then a tiny HTML→text step: `<li>` → `\n• `, `<p>`/`<h1-6>`/`<br>`/`<tr>` → `\n`, strip tags, decode `&amp; &lt; &gt; &quot; &#39; &nbsp;`. `meta.pages = null` |
| `latex` | UTF-8 text (validated with `new TextDecoder("utf-8",{fatal:true})`, no NUL) and (`.tex` name, or contains `\documentclass` or `\begin{document}`) | `source` = the text; `extractedText = latexToText(source)` |
| `text` | other valid UTF-8 text | `source` = `extractedText` = the text |
| rejected | OLE `D0 CF 11 E0` (legacy `.doc`), images, anything else | `415 UNSUPPORTED_FILE_TYPE` ("Save it as PDF or DOCX") |

- A file named `*.pdf`, `*.docx` or `*.doc` whose bytes don't match that format gives `415 UNSUPPORTED_FILE_TYPE`. An extension never upgrades or downgrades the detected kind.
- A corrupt or password-protected PDF, or an unparseable DOCX, gives `422 UNREADABLE_FILE`.
- `extractedText` is whitespace-normalized (trim lines, collapse runs of blank lines to one) and truncated to 100 000 chars (`meta.truncated = true`).
- **No selectable text:** if `extractedText.length < 200` for pdf/docx, set `meta.extractionWarning = "No selectable text found. ATS systems likely can't read this file either (scanned or image-only PDF?)."`. The upload still succeeds.

**`latexToText(source)`** is deterministic and pure (`extract.service.js`):
1. Convert CRLF to LF. Drop `%` comments (an unescaped `%` through end of line).
2. Keep only the body between `\begin{document}` and `\end{document}` when present.
3. Convert section-like commands, meaning control words whose name contains `section` (`\section*{X}`, `\resumeSection{X}`, …), to `\nX\n`.
4. Convert control words whose name contains `item` (`\item`, `\resumeItem{…}`, `\resumeSubItem{…}`, `\cvitem{…}`) to `\n• ` while keeping their brace content.
5. Convert `\href{url}{text}` → `text (url)`, and `\url{x}` → `x`.
6. Remove `\\`, `\newline`, `\vspace{…}`, `\hspace{…}` and `\hfill`, replacing line-break ones with a newline.
7. Convert `\begin{…}`/`\end{…}` to a newline.
8. Unescape `\% \& \$ \# \_ \{ \}`. Convert `~` → space, `---` → `—`, `--` → `–`, `$|$`/`\textbar` → `|`.
9. Remove every remaining `\controlword` plus its optional `[…]`. Turn the argument separator `}{` into ` | `, so Jake's `\resumeSubheading{a}{b}{c}{d}` becomes `a | b | c | d`. Remove the remaining braces.
10. Collapse spaces, trim lines, drop bullets with fewer than 2 words, and collapse blank lines.

## 5. Deterministic ATS scorer (`resume-lab/ats/`)

`scoreResume({text, kind, pages, profile: {skills: string[]}, job: JobRef|null, jobText: string|null}) → ScoreResult` is pure: no I/O, no randomness, and `computedAt` is added by the caller.

`scorerVersion = "ats-v1"`.

### 5.1 Text analysis (`ats/text.js`)

- **lines:** split `text` on `\n`, trim each, drop empty lines.
- **heading:** a line that, after stripping leading and trailing non-letters and a trailing `:`, is at most 40 chars and at most 5 words, and whose lowercase form equals a synonym or starts with `synonym + " "` (only for synonyms of 6+ chars).
  - Lines after a heading belong to that section until the next heading.
- **SECTION_SYNONYMS** (in `lexicon.js`):
  - `education`: education, academics, academic background, academic details, qualifications
  - `experience`: experience, work experience, professional experience, internships, internship, employment, work history
  - `projects`: projects, academic projects, personal projects, key projects
  - `skills`: skills, technical skills, core skills, skills & tools, technologies, tech stack, skills and interests
  - `achievements`: achievements, awards, honors, honours, accomplishments, certifications, certificates, extracurricular, extra-curricular activities, positions of responsibility, leadership, activities
  - `summary`: summary, profile, objective, career objective, about me, professional summary
- **bullets:**
  - Lines starting with one of `• ● ▪ ◦ ‣ ∙ · * - –` or a private-use char (U+E000–U+F8FF, icon fonts), followed by text. The glyph is stripped.
  - If fewer than 3 such lines exist, use a fallback: lines of 6–60 words inside the `experience`, `projects` and `achievements` sections.
- **words:** the count of matches of `/[A-Za-z0-9][A-Za-z0-9+#.'\/-]*/g` in `text`.
- **quantified bullet:** contains any of:
  - a percentage
  - a multiplier (`2x`, `10×`)
  - a currency amount (`₹ $ € £` followed by a digit)
  - a number with a magnitude suffix (`k K M L Cr lakh crore`)
  - a number with a unit (`ms s sec min hrs GB MB TB req/s rps qps`)
  - any integer ≥ 10 that is not a 4-digit year 1950–2039 and is not directly preceded by `v` or a letter
  - Examples: "Reduced latency by 35%" ✓, "Served 1,200 daily users" ✓, "Built 3 dashboards" ✗, "Python 3" ✗, "2023 – 2025" ✗.
- **ACTION_VERBS:** at least 60 lowercase verbs, for example built, developed, designed, implemented, led, created, launched, optimized, reduced, increased, improved, automated, deployed, engineered, architected, integrated, migrated, refactored, scaled, mentored, owned, delivered, analyzed, researched, published, won, organized, managed, coordinated, wrote, tested, debugged, secured, streamlined, accelerated, trained, modeled, visualized, shipped, achieved.
- **WEAK_PHRASES:** helped, assisted, worked on, responsible for, involved in, participated in, tasked with, duties included.
- **SKILL_TERMS:** at least 150 canonical terms, each with aliases. Example: `{ "node.js": ["node", "nodejs", "node js"], "postgresql": ["postgres", "psql"], "kubernetes": ["k8s"], "ci/cd": ["cicd", "continuous integration"], "machine learning": ["ml"] }`. Cover languages, web, mobile, data/ML, cloud/devops, databases, testing and CS fundamentals.
  - **Ambiguous terms** (`go`, `c`, `r`, `express`) are only matched through unambiguous aliases (`golang`, `c language`/`c programming`, `r programming`/`rstudio`, `express.js`/`expressjs`) or when listed explicitly in `job.skills` or `profile.skills`.
- **Matching:**
  - Lowercase the text, replace characters outside `[a-z0-9+#./]` with spaces, then pad with a leading and trailing space.
  - A term matches when ` alias ` occurs as a substring.
  - Unknown skills (not in the lexicon) match as a normalized phrase.

### 5.2 Checks (weights sum to 100). Points are kept unrounded; `score = Math.round(Σ points)`; `percent = Math.round(points / weight * 100)`

| id | label | weight | points | status |
|---|---|---|---|---|
| `sections` | Standard sections | 15 | +4 education, +4 skills, +4 (experience **or** projects), +1.5 achievements-family, +1.5 summary-family | pass: all three required found; warn: two found; fail: one or none |
| `contact` | Contact details | 10 | +4 email `/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i`; +3 phone (≥10 digits, optional `+cc`, spaces or dashes allowed); +1.5 `linkedin.com/in/`; +1.5 `github.com/`, `gitlab.com/` or any other `https?://` URL | pass: email and phone; warn: one of them; fail: neither |
| `keywords` | Keyword match | 25 | See **Keyword sources** below. In match mode: `25 × count(matched) / count(K)`. In breadth mode: `25 × min(count(F), 12) / 12` | pass ≥ 70%; warn ≥ 40%; fail below that |
| `impact` | Quantified impact | 15 | B = bullets, Q = quantified bullets: `B=0 ? 0 : 15 × min((Q/B)/0.5, 1)` | pass: Q/B ≥ 0.4; warn ≥ 0.2; fail below that |
| `action_verbs` | Action verbs | 10 | S = bullets whose first word ∈ ACTION_VERBS, Wk = bullets with a weak phrase: `max(0, 10 × min((S/B)/0.6, 1) − min(3, 0.5×Wk))`; B=0 gives 0 | pass: S/B ≥ 0.6 and Wk=0; warn: S/B ≥ 0.3; fail below that |
| `length` | Length | 10 | Words W: [350,900] → 10; [250,350) or (900,1100] → 7; [150,250) or (1100,1400] → 4; else 1. Then −3 if `pages > 2` (floor 0) | pass: 10; warn: 4–7; fail ≤ 3 |
| `readability` | ATS readability | 10 | +3 if at most 1 bullet contains `\bI\b`, `\bme\b`, `\bmy\b` or `\bmyself\b`; +`min(3, 3 × share(bullets with 8–35 words)/0.7)` (0 when B=0); +2 if a year `/\b(19\|20)\d{2}\b/` exists; +2 if `text.length ≥ 300` and ≤ 2% of characters are U+FFFD, private-use or control characters | pass ≥ 8; warn ≥ 5; fail below that |
| `depth` | Project/experience depth | 5 | `5 × min(B,6)/6 × (experience or projects section found ? 1 : 0.5)` | pass: 5; warn ≥ 2.5; fail below that |

**Keyword sources** for the `keywords` check, in order:
1. **Job:** `K` = canonical `job.skills` ∪ lexicon terms found in `job.title + jobText`.
2. **Profile:** if `K` is empty, use canonical `profile.skills` (at most 30), with `keywords.note = "This job has no description; scored against your profile skills"` when a job was given.
3. **Breadth:** if `K` is still empty, `F` = lexicon terms found in the resume (breadth mode).

**Grade:** A ≥ 85, B ≥ 70, C ≥ 55, otherwise D.

**Legacy rubric for `ResumeScoreCard`** (integers 0–100):
- `skillsMatch` = `percent(keywords)`
- `projectDepth` = `round((points(depth)+points(action_verbs))/15×100)`
- `quantifiedImpact` = `percent(impact)`
- `clarityAndFormatting` = `round((points(sections)+points(contact)+points(length)+points(readability))/45×100)`

**Strengths** (max 5): checks with `percent ≥ 80`, in the order keywords, sections, impact, contact, action_verbs, length, readability, depth. Templates:
- "Covers {m} of {n} key skills for {job.title}" / "Shows {m} of {n} skills from your profile" / "Lists {m} recognised technical skills"
- "Has the standard ATS sections: {list}"
- "{Q} of {B} bullets show measurable results"
- "Complete contact details"
- "{S} of {B} bullets start with strong action verbs"
- "Good length ({W} words)"
- "Clean, ATS-readable text"
- "Enough project and experience detail ({B} bullet points)"

**Improvements** (max 6): checks with `percent < 80`, sorted by `weight − points` descending. Each check's `suggestion` is one of:
- keywords (job): "Mention {≤5 missing} if you have used them — they appear in this job's requirements."
- keywords (profile): "Your profile lists {≤5 missing} but the resume doesn't mention them."
- keywords (breadth): "Add a Skills section listing the tools and languages you actually use."
- sections: "Add clear section headings for {missing}."
- impact: "Add numbers to more bullets — only {Q} of {B} show measurable results (aim for at least half)." When B=0: "Write experience and projects as bullet points with measurable results."
- contact: "Add {an email address / a phone number / your LinkedIn URL / a GitHub or portfolio link}."
- action_verbs: "Start bullets with strong verbs (built, designed, led…) — {S} of {B} do now." Append "Avoid 'helped/worked on' ({Wk} bullets)." when Wk > 0.
- length (short): "Your resume is short ({W} words) — add detail to projects and experience."
- length (long): "Trim to the most relevant content ({W} words; aim for 350–900 and at most 2 pages)."
- readability: pick the failing sub-check:
  - "Avoid 'I/my' in bullets."
  - "Keep bullets between 8 and 35 words."
  - "Add dates (month/year) to education and experience."
  - "ATS systems can't read this file's text (scanned or image-based PDF?) — upload a text-based PDF or DOCX."
- depth: "Add more detail to projects and experience — aim for at least 6 bullet points."

### 5.3 `ScoreResult` (`data` of the score endpoints; the first two keys are exactly what `ResumeScoreCard` reads)

```
{ score: 0-100 integer,
  feedback: { rubricBreakdown: { skillsMatch, projectDepth, quantifiedImpact, clarityAndFormatting },   // ints 0-100
              strengths: string[], improvements: string[] },
  grade: "A"|"B"|"C"|"D",
  breakdown: [{ id, label, weight, points /*1 decimal*/, percent, status: "pass"|"warn"|"fail", detail, suggestion: string|null,
                evidence: string[] /* ≤ 5, e.g. matched keywords or unquantified bullets truncated to 120 chars */ }],
  keywords: { source: "job"|"profile"|"breadth", total, matched: string[], missing: string[], note?: string },
  stats: { words, bullets, quantifiedBullets, actionVerbBullets, weakPhraseBullets, pages: number|null, sectionsFound: string[] },
  resume: { _id, title, kind, version, isPrimary } | null,
  target: { source, id, title, company } | null,
  scorerVersion: "ats-v1", computedAt: ISO }
```

- `scoreResumeById(user, resumeId?, {job?})` lives in `resume.service.js`. It loads `+extractedText`.
- **Profile:** `profile.skills` comes from `User.skills`.
- **Generic scores:** when no job is given, it writes `ats = {score, grade, sourceHash, scorerVersion, computedAt}`.
- **Job-targeted scores** are never stored.

## 6. LaTeX compiler (`resume-lab/latex/`)

### 6.1 Binary and process

- **Binary:** `TECTONIC_BIN`, else `backend/bin/tectonic` if it exists (downloaded by the postinstall script on Linux), else `tectonic` on PATH.
  - On this Mac, set `TECTONIC_BIN=/opt/homebrew/bin/tectonic` (verified: Tectonic 0.17.0).
  - The binary and the timeout are read **at call time**, so tests can change them.
- **Run:**
  - Create a temp dir with `mkdtemp(os.tmpdir()/"mpc-latex-")` and write `resume.tex`.
  - Run `execFile(bin, ["-Z","continue-on-errors","--untrusted","--outdir",dir,"resume.tex"], {cwd: dir, timeout: LATEX_COMPILE_TIMEOUT_MS, maxBuffer: 1 MiB, env: allowlist})`.
  - Read `resume.pdf`, then `rm -rf` the temp dir in `finally`.
- **Env allowlist** (only these, if set): `PATH HOME TMPDIR TEMP TMP LANG XDG_CACHE_HOME TECTONIC_CACHE_DIR SSL_CERT_FILE SSL_CERT_DIR HTTPS_PROXY HTTP_PROXY NO_PROXY`.
- **Success:**
  - Exit code 0 and `resume.pdf` starts with `%PDF-`.
  - With `continue-on-errors`, TeX errors can still exit 0 (verified). The header `X-Latex-Errors` reports the number of TeX diagnostics in stderr, meaning lines matching `/^error: [^:\s]+:\d+:/` (for example `error: resume.tex:5: Undefined control sequence`).
- **Concurrency:**
  - Semaphore of `LATEX_MAX_CONCURRENT` (default 2).
  - Waiting queue of up to `LATEX_MAX_QUEUE` (default 8). Queue overflow, or waiting longer than `LATEX_QUEUE_WAIT_MS`, gives `429 COMPILER_BUSY`.
- **Cache:**
  - In-memory LRU keyed by sha256 of the normalized source, holding `LATEX_CACHE_ENTRIES` PDFs (default 20, each ≤ 2 MB).
  - Saved latex resumes also persist the PDF in `pdf` (§2.1).
- **Error mapping** (fixes the Matchy bug where timeouts returned 400):
  - empty source → `400 VALIDATION`
  - more than `RESUME_MAX_SOURCE_BYTES` → `413 SOURCE_TOO_LARGE`
  - `error.code === "ENOENT"` → `503 COMPILER_UNAVAILABLE`
  - `error.killed === true || error.signal === "SIGTERM"` → `504 LATEX_COMPILE_TIMEOUT`
  - non-zero exit whose stderr matches `/download|fetch|resolve host|network|bundle/i` and contains no TeX diagnostics (`/^error: [^:\s]+:\d+:/`) → `503 COMPILER_UNAVAILABLE` ("LaTeX packages could not be downloaded — is the server offline?")
  - other non-zero exits, or no PDF → `422 LATEX_COMPILE_FAILED` with `errors[0].log` (at most 8 lines matching `/^(error:|!|l\.\d+)/`, ≤ 1 500 chars, temp paths replaced by `resume.tex`, secrets redacted per §6.3) and `errors[0].line` (the first `resume.tex:(\d+)` or `l.(\d+)` match, else null)

### 6.2 Normalization (`latex/normalize.js`, applied before the policy and compile)

1. Convert CRLF to LF. Strip a leading ```` ```latex|```tex|``` ```` fence and a trailing ```` ``` ````.
2. **Over-escaped mode** applies only when the source contains a literal `\\documentclass` or `\\begin{document}`:
   - de-escape `\\{2,}(?=[A-Za-z])` → `\`
   - convert a literal `\n` before whitespace or end of input to a newline
   - Outside this mode, `\\` line breaks are never touched. This fixes Matchy corrupting `\\Next` line breaks.
3. Remove the `pdftex` option from `\usepackage[…]{hyperref}` (Matchy behaviour).
4. **pdfTeX compatibility shim.** Tectonic runs XeTeX, and Jake's popular template (`\input{glyphtounicode}` + `\pdfgentounicode=1`) otherwise halts after 100 errors with no PDF (verified).
   - Prepend this text to line 1, **without a newline**, so error line numbers stay unchanged:
     `\ifdefined\pdfgentounicode\else\newcount\pdfgentounicode\fi\ifdefined\pdfglyphtounicode\else\def\pdfglyphtounicode#1#2{}\fi `
   - The policy scans the user's source **before** the shim is added.

### 6.3 Source policy and exfiltration guard (MANDATORY)

`checkLatexPolicy(source) → {ok:true} | {ok:false, construct, line}` runs on every compile path:
- `POST /resumes/compile`
- `/resume-bank/generated`
- the on-demand PDF for `/file` and `/access`

A violation gives `422 LATEX_FORBIDDEN` with message ``"For security, `<construct>` is not allowed (line N). Remove it and compile again."``.

**Reject:**
1. Any `^^` sequence (TeX hex escapes can spell a backslash).
2. These control words, matched as `\\name(?![A-Za-z@])`:
   - `csname`, `catcode`, `scantokens`
   - `openin`, `openout`, `read`, `readline`, `write`, `immediate`, `closein`, `closeout`, `newread`, `newwrite`
   - `special`, `directlua`, `luaexec`, `ShellEscape`, `graphicspath`
   - `XeTeXpicfile`, `XeTeXpdffile`
   - `pdfximage`, `pdffiledump`, `pdfmdfivesum`, `pdffilesize`, `pdffilemoddate`
3. Any control word whose name contains `input` or `include` (case-insensitive). Examples: `\@@input`, `\InputIfFileExists`, `\verbatiminput`, `\lstinputlisting`, `\inputminted`, `\includepdf`, `\includesvg`, `\subimport`. **Exceptions:**
   - `\input` and `\include`, when followed (after optional whitespace) by `{NAME}` or a bare `NAME`, where `NAME` matches `^[A-Za-z0-9_-]+(\.tex)?$`. Anything else after them (another control sequence, `}`, end of input, a path) is rejected.
   - `\includegraphics[…]{NAME}` with `NAME` matching `^[A-Za-z0-9_-]+(\.(png|jpe?g|pdf|eps))?$`.
4. Path-bearing arguments: every comma-separated name in `\documentclass`, `\usepackage`, `\RequirePackage`, `\LoadClass`, `\bibliography` and `\addbibresource` must match `^[A-Za-z0-9_-]+$` after trimming. Option lists in `[...]` are not checked.
5. `\begin{filecontents}` and `\begin{filecontents*}`.
6. Font file paths: `\font\x="[…]"` or `\font\x=[…]`, and the `Path=` key inside `\fontspec`/`\setmainfont` options.

**Allowed examples** (tests must pass these):
- `\input{glyphtounicode}`
- `\usepackage[hidelinks]{hyperref}`
- `\usepackage[utf8]{inputenc}`
- `\usepackage{amsmath, amssymb}`
- `\makeatletter`
- `\newcommand{\resumeItem}[1]{\item\small{{#1 \vspace{-2pt}}}}`
- `\pdfgentounicode=1`

**Secret scan (backstop):**
- After a successful compile, extract the PDF text with `unpdf` and remove all whitespace.
- If it contains, whitespace-removed, the value of any env var whose name matches `/(SECRET|PASS(WORD)?|TOKEN|KEY|MONGO_?URI|MONGODB_URI|DATABASE_URL)$/i` and whose value is 12 chars or longer:
  - discard the PDF and answer `422 LATEX_FORBIDDEN` with `errors[0].construct = "secret"`;
  - log `[resume-lab] blocked secret exfiltration attempt by <userId>` without the value.
- The same values are redacted as `[redacted]` in any compile `log` returned to clients.

**Residual risk:** the user's own server account can still read other non-secret files the policy misses. Production should run the backend in a container whose filesystem holds no secrets (env-only configuration, no `.env` file, read-only image).

## 7. Job references and job descriptions (`resume-lab/services/job-ref.service.js`)

Other modules are reached **lazily at call time**, never through static imports:
- **campus:** `mongoose.models.Job` and `mongoose.models.Company`. Visibility uses `jobScope(user, {appliedJobIds})` from `backend/src/modules/placements/services/scope.js` (PLACEMENTS §1) when that module exists. Otherwise the student rule applies: `{status: "active"}`, or `"closed"` when the student applied, with `college ∈ [user.college, null]`.
- **market:** `getExternalJob(id)` and `resolveMarketJob(ref, {user})` from `backend/src/modules/job-feed/feed.service.js` (JOB-FEED §17). If that module is missing, fall back to read-only `mongoose.models.ExternalJob`.

An unavailable source means its jobs are never found. This area **never writes** `Job` or `ExternalJob`.

```
JobRef = { source: "campus"|"market", id, title, company, description, skills: string[], location, applyUrl }

normalizeJobSource(v): "campus" → "campus"; "market" | "external" → "market"; undefined → undefined; else 400 VALIDATION (field "jobSource")

resolveJob({jobSource?, jobId}, {user}) → JobRef
  jobId must be a 24-hex ObjectId (else 400 VALIDATION, field "jobId")
  campus: Job.findOne({_id: jobId, ...scope}), populate company "name" when Company is registered.
          title, company = job.company?.name ?? job.companyName ?? "", description ?? "", skills ?? [], location,
          applyUrl = job.applicationUrl ?? null
  market: getExternalJob(jobId) → PublicExternalJob {id, kind:"external", title, company, location, applyUrl, description}
          → source "market", skills = Array.isArray(job.skills) ? job.skills : []
  jobSource omitted: try campus, then market
  not found or out of scope → fail(404, "Job not found", "NOT_FOUND", {entity: "job"})

resolveJobRef(ref, {user}) → JobRef | {ambiguous: true, message, candidates: [{id: "campus:<id>"|"market:<id>", label}]}
  1. {jobSource?|source?|kind?, jobId?|id} | "campus:<id>" | "market:<id>" | "external:<id>" | "<24-hex id>" → resolveJob
  2. free text (2–200 chars):
     a. campus (PLACEMENTS §12.1 rule): every whitespace token (≥ 2 chars, at most 6, escapeRegex, case-insensitive) must match
        somewhere in "{companyName} {title}", within the scope above; prefer status active, then newest; limit 10
     b. market: resolveMarketJob(text, {user}). Its 404 means "no market match"; its {ambiguous} result supplies candidates
     c. exactly one campus match and no market match → campus. No campus match → the market outcome passes through
        (job, ambiguous or 404). Otherwise ambiguous: candidates are campus first, then market (≤ 5 total), labelled
        "<title> · <company> (campus drive|market job)"
     d. no match anywhere → fail(404, "No job matches '<text>'", "NOT_FOUND", {entity: "job"})

resolveJobDescription({user, job: JobRef|null, manualText, save = true}) → {text: string|null, source: "request"|"saved"|"job"|null}
  manualText trimmed: 1–29 chars → 400 VALIDATION ("Paste the full job description (at least 30 characters)"); > 20 000 → 400 VALIDATION
  1. manualText ≥ 30 chars → if job && save: upsert JobDescriptionOverride(user, job.source, job.id); return {text, source: "request"}
  2. job → JobDescriptionOverride for (user, source, id) → {text, source: "saved"}
  3. job → job.description.trim() ≥ 30 chars → {text, source: "job"}
  4. → {text: null, source: null}
  Shared job documents are NEVER modified.

jobContextBlock(job, text) = "Title: {title}\nCompany: {company}\n[Key skills: {skills.join(", ")}\n]\n{text}"
```

The same resolver serves tailoring (§9.5), job-targeted scoring (§5) and the tools (§12).

## 8. REST API — resume-lab

### 8.0 Error codes (`errors[0].code`)

| code | HTTP | when |
|---|---|---|
| `VALIDATION` | 400 | missing or invalid fields, ids or enums (`field`) |
| `UNSUPPORTED_PROVIDER` | 400 | unknown LLM provider |
| `UNAUTHORIZED` | 401 | no or invalid token (`requireAuth`) |
| `FORBIDDEN` | 403 | role check, or a resume that was not shared with this alumnus |
| `INVALID_SIGNATURE` / `LINK_EXPIRED` | 403 | signed file link (§8.4) |
| `NOT_FOUND` | 404 | resume, job or credential missing **or not owned** (`entity`); 404 rather than 403 avoids enumeration |
| `RESUME_LIMIT` | 409 | more than `RESUME_MAX_PER_USER` active resumes |
| `NOT_EDITABLE` | 409 | content change or apply on pdf/docx |
| `RESUME_LOCKED` | 409 | content change on a locked resume |
| `RESUME_ARCHIVED` | 409 | edit or set-primary on an archived resume |
| `REVISION_CONFLICT` | 409 | `expectedRevision` mismatch (`currentRevision`) |
| `NO_PDF` | 409 | `variant=pdf` for docx/text |
| `TOO_MANY_KEYS` | 409 | more than `LLM_MAX_CREDENTIALS` |
| `FILE_TOO_LARGE` | 413 | upload larger than `RESUME_MAX_UPLOAD_BYTES` |
| `SOURCE_TOO_LARGE` | 413 | LaTeX or text larger than `RESUME_MAX_SOURCE_BYTES` |
| `UNSUPPORTED_FILE_TYPE` | 415 | §4 |
| `UNREADABLE_FILE` | 422 | corrupt or encrypted file; no text to tailor |
| `LATEX_FORBIDDEN` | 422 | §6.3 (`construct`, `line`) |
| `LATEX_COMPILE_FAILED` | 422 | §6.1 (`log`, `line`) |
| `NO_PATCHES_APPLIED` | 422 | apply-patches applied nothing (`skipped`) |
| `LLM_KEY_REQUIRED` / `LLM_KEY_INVALID` / `LLM_MODEL_NOT_FOUND` / `LLM_BAD_REQUEST` / `LLM_REFUSED` | 422 | §9.3 |
| `TOO_MANY_ATTEMPTS` | 429 | local rate limits (`core/rate-limit.js` default code) |
| `COMPILER_BUSY` | 429 | compile queue full |
| `LLM_RATE_LIMITED` | 429 | provider 429 |
| `LLM_TRUNCATED` / `LLM_BAD_JSON` / `LLM_PROVIDER_ERROR` | 502 | §9.3, §9.5 |
| `STORAGE_UNAVAILABLE` / `COMPILER_UNAVAILABLE` / `BYOK_DISABLED` | 503 | driver, Tectonic or encryption key missing |
| `LATEX_COMPILE_TIMEOUT` / `LLM_TIMEOUT` | 504 | timeouts |

**Roles and rate limits:**
- Every resume-lab route requires `requireAuth` plus `requireRole("student")` (admin passes as superuser).
- Exceptions:
  - `GET /resume-bank/:id/access`: owner, or an alumnus with a share.
  - `GET /resumes/:id/file`: valid signature, or the JWT owner.
- Rate limits use `rateLimit({keyFn: req => String(req.user._id)})`:
  - uploads: 20 per 10 min
  - compiles (including on-demand ones): 20 per min
  - `/file`: 60 per min per IP

Every mutation emits `resume:changed` (§10).

### 8.1 Legacy SIH routes (`/api/v1/resume`, router `legacy.routes.js`)

| Method, path | Request | 2xx `data` | Errors |
|---|---|---|---|
| `POST /upload` | multipart: file `resume` (or `file`) **or** text field `text`; optional `title`, `makePrimary` (`"true"`/`"false"`, default **true**), `jobId`, `jobSource` (score target) | 201 when created, 200 when deduplicated: `ScoreResult` plus `created: boolean` (its `resume` is the stored resume) | 400, 409 RESUME_LIMIT, 413, 415, 422 UNREADABLE_FILE, 429, 503 STORAGE_UNAVAILABLE |
| `GET /score?resumeId&jobId&jobSource` | none; default is the primary resume, else the most recent active one | 200 `ScoreResult`, or **`null`** when the student has no active resume | 400, 404 (resume or job) |
| `POST /score/preview` | JSON `{text, jobId?, jobSource?}` (≤ `RESUME_MAX_SOURCE_BYTES`) | 200 `ScoreResult` with `resume: null`. **Nothing is stored** (used by the card's "TEST SAMPLE RESUME") | 400, 413 |

Wherever this contract takes `jobSource`, the alias param `jobKind` and the alias value `"external"` (meaning `"market"`) are also accepted (§7 `normalizeJobSource`).

**Upload flow:**
1. Sniff the type (§4) and extract text.
2. Deduplicate against the owner's **active** resumes (`original.sha256` for files, `sourceHash` for text). A match returns the existing resume and still applies `makePrimary`.
3. Store `original` (pdf/docx only).
4. Create the resume with `origin: "uploaded"`.
5. Default title: the filename without its extension (sanitized), or `"Pasted resume"` for text.
6. Score it (with the job, if given) and write `ats`.

### 8.2 Resume Bank compatibility (`/api/v1/resume-bank`, router `bank.routes.js`; same paths and shapes as SIH)

| Method, path | Request | 2xx `data` | Errors |
|---|---|---|---|
| `GET /` | — | `BankItem[]`: active resumes of **all kinds**, `version` descending (`ResumeStudio` reads `_id, title, version, createdAt`) | — |
| `POST /generated` | `{latexCode, title?, targetJob?}` | 201 new, or 200 when the `dedupeKey` already exists (archived or not): `BankItem` + `pdfStatus: "ready"\|"pending"` | 400, 409 RESUME_LIMIT, 413, 422 LATEX_FORBIDDEN / LATEX_COMPILE_FAILED, 504 LATEX_COMPILE_TIMEOUT |
| `GET /:id/access?variant=pdf\|original` | — | `{url, expiresAt, variant, kind}`, valid `RESUME_FILE_URL_TTL_SECONDS` (10 min) | 400, 404, 403 FORBIDDEN, compile errors (latex) |

**`POST /generated` flow:**
- The student-profile requirement is removed (`createdBy` is set only when `user.student` exists).
- `title` defaults to `title || targetJob.roleTitle || targetJob.title || "Generated Resume"` (SIH rule).
- `targetJob` is trimmed: string fields longer than 4 000 chars are truncated, and the whole object must be ≤ 16 KB.
- Compile through §6:
  - policy, compile or timeout errors → error and **no save** (SIH semantics);
  - `COMPILER_UNAVAILABLE` / `COMPILER_BUSY` → save without `pdf` and answer `pdfStatus: "pending"`.
- Create with `kind: latex, origin: generated, dedupeKey`. The resume is primary only if the owner has none.
- E11000 on `dedupeKey` → return the existing doc with 200. E11000 on `version` → retry.

**`GET /:id/access` authorization (SIH rule, unchanged):**
- The owner is allowed.
- Role `alumni` is allowed when a `MentorshipMessage{type:"resume-share", resumeVersion:id}` belongs to an `AlumniConnection{alumniUser: me, status ∈ accepted|closed}`.
- Everyone else gets `403 FORBIDDEN` ("This resume has not been shared with you").
- Archived (locked) resumes stay accessible to alumni they were shared with.
- **Default variant:** `pdf` for latex and pdf kinds, `original` otherwise. For latex with a stale or missing `pdf`, the PDF is compiled and stored **before** answering, so compile errors reach the caller.

### 8.3 Catalog (`/api/v1/resumes`, router `resumes.routes.js`, the module's `mountPath`)

Static paths (`/compile`) are declared before `/:id` routes. Every `:id` is checked with `assertObjectId`.

| Method, path | Request | 2xx `data` | Errors |
|---|---|---|---|
| `GET /` | `?status=active\|archived\|all` (default active), `?kind=` | `{resumes: ResumeSummary[], primaryId, limit}`, sorted `isPrimary` desc, `updatedAt` desc (≤ 200) | 400 |
| `POST /` | JSON `{title?, kind?: "latex"\|"text", content, makePrimary? = true, targetJob?}` (kind is inferred from `\documentclass` / `\begin{document}` when omitted) **or** multipart as in §8.1 | 201, or 200 when deduplicated: `{resume: ResumeSummary, created}` | 400, 409, 413, 415, 422, 503 |
| `GET /:id` | — | `{resume: ResumeDetail, content, contentKind: "latex"\|"text"\|"extracted"}` (`content` = `source`, or `extractedText` for pdf/docx) | 400, 404 |
| `PUT /:id` (alias `PATCH`) | `{title?, content?, targetJob?, expectedRevision?}`, at least one field | `{resume}` | 400, 404, 409 NOT_EDITABLE / RESUME_LOCKED / RESUME_ARCHIVED / REVISION_CONFLICT, 413 |
| `DELETE /:id` | — | `{deleted: boolean, archived: boolean, primaryId}`. Unlocked → hard delete (doc + files). Locked → archive | 400, 404 |
| `POST /:id/restore` | — | `{resume}` (status active) | 404, 409 RESUME_LIMIT |
| `POST /:id/primary` | — | `{resume, previousPrimaryId}` | 404, 409 RESUME_ARCHIVED |
| `POST /:id/duplicate` | `{title?}` (default `"<title> (copy)"`) | 201 `{resume}` (`origin: duplicated`, `parent`, unlocked, not primary) | 404, 409 RESUME_LIMIT |
| `POST /:id/apply-patches` | see below | 201 (new version) or 200 (in place): `{resume, applied: string[], skipped: [{id, reason}]}` | 400, 404, 409 NOT_EDITABLE / RESUME_LOCKED, 422 NO_PATCHES_APPLIED |
| `GET /:id/score?jobId&jobSource` | — | `ScoreResult` | 400, 404 |
| `POST /compile` | `{latex}` **or** `{resumeId}` | 200 `application/pdf` bytes; headers `Content-Disposition: inline; filename="resume.pdf"`, `Cache-Control: no-store`, `X-Latex-Errors: <n>`, `X-Compile-Ms`. `{resumeId}` also refreshes the stored `pdf` | 400, 404, 409 NO_PDF (non-latex), 413, 422, 429, 503, 504 (JSON envelope) |
| `GET /:id/access?variant=` | — | same as §8.2 (owner only) | as §8.2 |
| `GET /:id/file?variant=pdf\|original&download=0\|1` | signed query (§8.4) **or** JWT owner | bytes; see §8.4 | 400, 403, 404, 409 NO_PDF, compile errors |

**`POST /:id/apply-patches`** body:
```
{ patches: [{ id, charRange: {startChar, endChar}, originalSubstring, replacementSubstring }],   // 1–50 entries (accepted subset chosen by the user)
  baseSourceHash?: string,                // sourceHash returned by the tailor call
  mode?: "new-version" | "in-place",      // default "new-version"
  title?: string,                         // new-version title; default "<base title> – <targetJob.company || targetJob.title>" (≤ 200)
  targetJob?: { source, id, title, company },
  makePrimary?: boolean }                 // default false
```

Rules (helpers in `services/patches.js`):
1. Only `kind ∈ {latex, text}` (else `409 NOT_EDITABLE`, "Suggestions for PDF/DOCX resumes can't be applied automatically").
2. `in-place` needs an unlocked resume.
3. **Locate each patch:** if `source.slice(start, end) === originalSubstring`, keep it. Otherwise (including when `baseSourceHash` differs), relocate to the exact occurrence nearest the old `startChar`; if none exists, skip it with `stale`.
4. Sort by `startChar`. A patch that overlaps an already accepted one is skipped with `overlap`.
5. **LaTeX checks:** `braceDelta(replacement) !== braceDelta(original)` → `unbalanced_braces` (`braceDelta` counts unescaped `{` minus `}`; a brace preceded by an odd number of `\` is escaped). An unescaped `%`, `&` or `#` that the original lacks is auto-escaped.
6. Apply in **descending** `startChar` order. If nothing was applied → `422 NO_PATCHES_APPLIED`.
7. **Save:**
   - `new-version`: create a resume with `origin: "tailored"`, `parent`, `targetJob` (stored with the `roleTitle`/`companyName` aliases), copied kind and the new source.
   - `in-place`: update with `revision + 1`.

### 8.4 Signed file links (`access.service.js`)

```
buildResumeAccessUrl(resume, { viewerId, variant?, ttlSeconds = RESUME_FILE_URL_TTL_SECONDS }) → { url, expiresAt, variant }
  exp = now + ttl (unix seconds)
  sig = base64url(HMAC_SHA256(RESUME_FILE_URL_SECRET, `${resumeId}|${variant}|${exp}|${viewerId}`))
  url = `${PUBLIC_API_URL}/api/v1/resumes/${resumeId}/file?variant=${variant}&exp=${exp}&viewer=${viewerId}&sig=${sig}`
        (PUBLIC_API_URL empty → root-relative URL: the frontend uses the same origin through the Vite proxy or reverse proxy)
```

**Verifying `/file`:**
- If `sig` is present, verify it with `crypto.timingSafeEqual` (lengths compared first) → else `403 INVALID_SIGNATURE`.
- `exp` must be later than now → else `403 LINK_EXPIRED`.
- Without `sig`, run `requireAuth` and require the owner.

**Responses by variant and kind:**

| variant | latex | pdf | docx | text |
|---|---|---|---|---|
| `pdf` | cached PDF; compile on demand when stale | the original | `409 NO_PDF` | `409 NO_PDF` |
| `original` | `.tex` source (`application/x-tex`) | the original | the original (`.docx`) | `.txt` (`text/plain; charset=utf-8`) |

**Headers:**
- `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox`, `Cache-Control: private, no-store`.
- `Content-Disposition: inline` (`attachment` when `download=1`) with an ASCII-sanitized filename plus RFC 5987 `filename*=UTF-8''…`.

**Delivery:**
- local: Node streams the file.
- cloudinary / uploadthing: `302` to `driver.signedUrl(file, {expiresInSeconds: 60})`.

## 9. BYOK (`/api/v1/llm`, module `byok`)

### 9.1 Providers (`byok/providers.js`, port of MBE `config/llm.js`)

| id | label | defaultModel | endpoint |
|---|---|---|---|
| `openai` | OpenAI | `gpt-4o-mini` | `https://api.openai.com/v1/chat/completions` |
| `anthropic` | Anthropic | **`claude-haiku-5-5`** | `https://api.anthropic.com/v1/messages` |
| `google` | Google | `gemini-3.1-pro-preview` | `https://generativelanguage.googleapis.com/v1beta/models` |
| `xai` | xAI | `grok-3-mini` | `https://api.x.ai/v1/chat/completions` |

**`normalizeLlmModel(provider, model)`:**
- anthropic: `claude-3-5-haiku-latest`, `claude-3-5-haiku-20241022` and `claude-3-haiku-20240307` (retired Haiku models) → `claude-haiku-5-5`.
- google: `gemini-2.5-pro` → `gemini-3.1-pro-preview`.
- Anything else is returned unchanged.

Apply it when saving, listing, selecting and calling, so legacy saved models are never sent.

**Other exports:**
- `getLlmProvider(p)`: trims and lowercases; unknown → `fail(400, "Unsupported LLM provider. Choose one of: openai, anthropic, google, xai.", "UNSUPPORTED_PROVIDER")`.
- `LLM_SYSTEM_PROMPT`: the same text as MBE `constants.js`.

### 9.2 Credentials (`services/credentials.service.js`, port of `llm-credentials.service.js`)

- AES-256-GCM. The key is `Buffer.from(LLM_CREDENTIAL_ENCRYPTION_KEY, "base64")` and must be 32 bytes. Stored format: `ivB64.tagB64.cipherB64` (12-byte IV), exactly Matchy's format.
- `isByokEnabled()` checks the key **at call time**. When it fails, every `/llm` route except `/job-descriptions` answers `503 BYOK_DISABLED` ("AI keys are not configured on this server"), and `start()` logs one warning.
- `maskApiKey(k)`: `first4 + "••••" + last4`, or `"••••••••"` when the key is 8 chars or shorter.
- **Decrypt failure** (changed or rotated key): treat the credential as `broken`. Listing still returns 200. Using it gives `422 LLM_KEY_INVALID` and a notification (§11).
- **Credential selection** `pickCredential(userId, {credentialId?, provider?})`:
  1. An ObjectId `credentialId` must exist (and match `provider` when both are given), else `404 NOT_FOUND {entity:"credential"}`.
  2. Else, with `provider`: that provider's most recently `updatedAt` credential.
  3. Else: the most recently updated credential overall.
  4. None → `422 LLM_KEY_REQUIRED` ("Add an API key for resume tailoring first (Resume Lab → AI keys).").
- **Model:** request `model` → credential `model` → provider default, then normalized.
- **Never** log, return or embed a decrypted key in an error, notification or URL. Log only `{provider, model, status, ms}`.

### 9.3 Provider client (`services/llm-client.js`, port of `GenericLlmClient`; raw `fetch`, no SDKs)

`complete(messages, {jsonMode}) → {provider, model, content, stopReason, usage: {inputTokens, outputTokens} | null}`:
- Messages are validated as in Matchy: a non-empty array of `{role ∈ user|assistant|system, content: string}`.
- `LLM_SYSTEM_PROMPT` is prepended when no system message is present.
- `fetch` is read from `globalThis` **at call time** (tests stub it), with `AbortSignal.timeout(LLM_REQUEST_TIMEOUT_MS)`.
- Abort or timeout → `504 LLM_TIMEOUT`; network failure → `502 LLM_PROVIDER_ERROR`.

| provider | request (exact) | before reading content | content |
|---|---|---|---|
| anthropic | `POST https://api.anthropic.com/v1/messages`, headers `content-type: application/json`, `x-api-key: <key>`, `anthropic-version: 2023-06-01` (no `anthropic-beta`). Body has **exactly** `{model, max_tokens: LLM_ANTHROPIC_MAX_TOKENS (16000), system: <system messages joined with "\n">, messages: <non-system>}`. **Never** `temperature`, `top_p` or `top_k` (non-default values are rejected with 400 on current models), and no `thinking` / `output_config` | `stop_reason === "refusal"` → `422 LLM_REFUSED`, "The AI model declined this request (safety filter). Try a different job description or another model.", `errors[0].category = stop_details?.category ?? null`. `stop_reason === "max_tokens"` → `502 LLM_TRUNCATED`, "The AI's answer was cut off before it finished. Try again, choose a larger model, or shorten the job description." `pause_turn` / `tool_use` → `502 LLM_PROVIDER_ERROR`. `end_turn` / `stop_sequence` → OK | join `.text` of blocks with `type === "text"` **only**. `claude-haiku-5-5` thinks by default, so `thinking` blocks may come first and count toward `max_tokens`, which is why the default is 16000 |
| openai, xai | `POST …/chat/completions`, `authorization: Bearer <key>`, body `{model, messages, response_format: {type:"json_object"}` (jsonMode only)`}` | `finish_reason === "length"` → `LLM_TRUNCATED`; `"content_filter"`, or a non-empty `message.refusal` → `LLM_REFUSED` | `choices[0].message.content` |
| google | `POST …/models/{model}:generateContent`, header **`x-goog-api-key: <key>`** (never `?key=` in the URL), body `{systemInstruction?, contents, generationConfig: {responseMimeType: "application/json"}` (jsonMode)`}` | `promptFeedback.blockReason`, or `candidates[0].finishReason ∈ {SAFETY, RECITATION, BLOCKLIST, PROHIBITED_CONTENT, SPII}` → `LLM_REFUSED`; `MAX_TOKENS` → `LLM_TRUNCATED`; no candidates → `LLM_PROVIDER_ERROR` | join `parts[].text`, skipping parts with `thought: true` |

**HTTP error mapping** (all providers; the message is the provider's `error.message` with the key redacted):
- 400 or 413 → `422 LLM_BAD_REQUEST`
- 401 or 403 → `422 LLM_KEY_INVALID` (plus notification §11 when a saved credential was used)
- 404 → `422 LLM_MODEL_NOT_FOUND`
- 429 → `429 LLM_RATE_LIMITED` ("Your provider account is rate-limited or out of credit.")
- 5xx or 529 → `502 LLM_PROVIDER_ERROR`

**`listProviderModels(provider, apiKey)`** (timeout `LLM_MODELS_TIMEOUT_MS`):

| provider | request | pagination and filtering |
|---|---|---|
| anthropic | `GET https://api.anthropic.com/v1/models?limit=100` with `x-api-key` and `anthropic-version: 2023-06-01` | follow `has_more` using `after_id=<last_id>`, at most 5 pages → `data[].id` |
| google | `GET …/v1beta/models?pageSize=1000` with `x-goog-api-key` | follow `nextPageToken`, at most 5 pages; keep `supportedGenerationMethods ∋ generateContent`; strip `models/` |
| openai, xai | `GET …/v1/models` | drop ids matching `/embedding\|whisper\|tts\|dall-e\|moderation\|transcribe\|realtime\|audio\|image/` |

### 9.4 REST (`byok/routes.js`)

All routes use `requireAuth` and work for any role, except `/tailor` (`requireRole("student")`).

| Method, path | Request | 2xx `data` | Errors |
|---|---|---|---|
| `GET /providers` | — | `Provider[]` in table order. `Provider = {id, label, defaultModel, configured, model /* first credential's normalized model or default */, maskedApiKey /* first credential's */, credentials: [{id, label, model, maskedApiKey /* keyHint; null when broken */, updatedAt, broken}]}`. A decrypt failure never gives 500 | 503 |
| `POST /providers/:provider/models` | `{apiKey?}` or `{credentialId?}` (with neither: the provider's newest saved key) | `{provider, models: string[], source: "request"\|"saved"}` | 400, 404, 422 LLM_KEY_REQUIRED / LLM_KEY_INVALID, 429, 502, 503, 504 |
| `PUT /credentials/:provider` | `{apiKey (8–512 chars, no whitespace), model?, label? (≤80; default "<Label> key")}`. **Appends** a credential | 201 `{credentialId, label, provider, model, maskedApiKey}` | 400, 409 TOO_MANY_KEYS, 503 |
| `PATCH /credentials/:provider/:credentialId` | `{label?, model?, apiKey?}`; at least one | `{credentialId, label, provider, model, maskedApiKey}` | 400, 404, 503 |
| `DELETE /credentials/:provider/:credentialId` | — | `{deleted: 0\|1}` | 400 |
| `DELETE /credentials/:provider` | — | `{deleted: n}` (all keys of the provider) | 400 |
| `POST /tailor` | TailorRequest (§9.5) | TailorResult or NeedsJd (§9.5) | 400, 404, 413, 422, 429, 502, 503, 504 |
| `POST /chat` | `{messages (≤40, ≤100 000 chars total), credentialId?, provider?, model?}`. **Compat:** a body containing `resumeContent` is handled exactly like `/tailor`, including its `student` role check | `{provider, model, content, stopReason, usage}` | as `/tailor` |
| `GET /job-descriptions/:jobSource/:jobId` | — | `{job: {source,id,title,company}, text, textSource: "saved"\|"job"\|null, updatedAt}` | 400, 404 |
| `PUT /job-descriptions/:jobSource/:jobId` | `{text}` (30–20 000) | `{job, text, textSource: "saved", updatedAt}` | 400, 404 |
| `DELETE /job-descriptions/:jobSource/:jobId` | — | `{deleted: 0\|1}` | 400 |

**`PUT /credentials` implementation:**
```
User.updateOne(
  {_id, $expr: {$lt: [{$size: {$ifNull: ["$llmCredentials", []]}}, LLM_MAX_CREDENTIALS]}},
  {$push: {llmCredentials: {...}}})
```
`matchedCount === 0` → `409 TOO_MANY_KEYS`.

**Rate limits:** `/tailor` and `/chat` share `TAILOR_RATE_LIMIT_PER_HOUR` per user (default 30); `/providers/:p/models` allows 20 per 10 min.

### 9.5 Surgical tailoring (`services/tailor.service.js`, port of MBE `callLlm`)

**Request:**
```
TailorRequest = {
  resumeId?: string,                              // preferred
  resumeContent?: string, fileType?: "tex"|"txt", // Matchy compat when resumeId is absent (fileType inferred: \documentclass → tex)
  jobId?: string, jobSource?: "campus"|"market",  // canonical (UI-ACTIONS names); "external" and jobKind accepted
  job?: { source?|kind?, id },                    // alias object
  applyingId?: string,                            // Matchy alias of jobId
  manualJobDescription?: string, saveJobDescription?: boolean /* default true */,
  credentialId?: string, provider?: string, model?: string }
```

**Steps:**
1. **Validate:** exactly one of `resumeId` / `resumeContent`, else 400. Job, manual JD, or both, else 400 ("Pick a job or paste a job description").
2. **Resolve the resume:**
   - latex → `source`, fileType `tex`
   - text → `source`, `txt`
   - pdf/docx → `extractedText`, `txt`, `appliesTo: "extracted_text"`. An empty text gives `422 UNREADABLE_FILE`.
   - Over `RESUME_MAX_SOURCE_BYTES` → `413 SOURCE_TOO_LARGE`.
3. Resolve the job (§7), which can give 404.
4. `pickCredential` (§9.2), which can give `422 LLM_KEY_REQUIRED`. The credential is checked before the JD, as Matchy does.
5. `resolveJobDescription`. If there is no text, return **200** `NeedsJd` **without** calling the LLM:
   `{success:false, requiresManualJD:true, message:"Hey, please paste the job description—I'm not able to get it automatically. Just copy and paste the job description over here.", job, jobId, jobSource, resumeId}`
6. **Prompt:**
   - System: MBE `RESUME_DIFF_SYSTEM_PROMPT` **verbatim** (the current 8-rule version in `llm.controller.js`).
   - User: Matchy's template with the `JOB DESCRIPTION` block set to `jobContextBlock(job, text)` and `USER RESUME (<TEX|TXT> FORMAT WITH LINE TAGS)` with `[Ln] ` tags.
   - `complete(…, {jsonMode:true})`.
7. **`parseJsonLoose`:**
   - trim, strip leading ```` ```json ````/```` ``` ```` and the trailing fence, then `JSON.parse`;
   - otherwise parse the slice from the first `{` to the last `}`;
   - otherwise `502 LLM_BAD_JSON` ("The AI returned an unreadable answer. Try again or pick another model.").
   - A `suggestions` value that is not an array also gives `LLM_BAD_JSON`.
8. **`validateAndLocatePatches(source, suggestions, isLatex)`** (in `resume-lab/services/patches.js`; fixes Matchy bugs):
   - Strip `^\[L\d+\]\s?` from **every line** of `originalSubstring` and `replacementSubstring`.
   - Non-string or empty → `invalid`; equal → `unchanged`.
   - Use every exact occurrence and pick the one nearest `lineNumber`; none → `not_found`.
   - LaTeX: brace-delta rule and auto-escape (§8.3 rule 5) → `unbalanced_braces`.
   - `charRange = {startChar, endChar: startChar + original.length}` (UTF-16, end exclusive).
   - `lineRange.startLine` is the line of `startChar`. `endLine = startLine + (count of "\n" in original) − (original ends with "\n" ? 1 : 0)`, which fixes Matchy's off-by-one.
   - Sort by `startChar`, drop overlaps (`overlap`), keep at most 25 (`limit`), and renumber ids `patch_1…` in document order.
   - Field caps: `section` (default "General"), `targetContext` ≤ 200, `reasoning` ≤ 500, `keywordsAdded` ≤ 10 × 60 chars.

**Response:**
```
TailorResult = { success: true, requiresManualJD: false,
  resumeId: string|null, sourceHash, revision: number|null, fileType: "tex"|"txt", appliesTo: "source"|"extracted_text",
  job: {source, id, title, company} | null, jobId: string|null, jobSource: "campus"|"market"|null,
  jobDescriptionSource: "request"|"saved"|"job",
  provider, model, credentialId,
  missingKeywordsFound: string[] /* ≤ 30 */, totalPatches, patches: Patch[],
  skipped: [{ id /* LLM id or index */, reason: "invalid"|"unchanged"|"not_found"|"unbalanced_braces"|"overlap"|"limit" }],
  generatedAt: ISO }
Patch = { id, section, targetContext, lineRange: {startLine, endLine}, charRange: {startChar, endChar},
          originalSubstring, replacementSubstring, keywordsAdded: string[], reasoning, autoEscaped?: true }
```

Tailoring never modifies a resume. Applying is done by `POST /resumes/:id/apply-patches` (§8.3) or, as in Matchy, client-side followed by `PUT`.

## 10. Socket events

Server → client only, sent to room `user:<ownerId>` with `emitToUser`. No client → server events.

- `resume:changed`: `{action: "created"|"updated"|"archived"|"deleted"|"restored"|"primary"|"locked", resumeId, resume: ResumeSummary|null, primaryId: string|null}`.
  - It fires after every mutation, including `/resume/upload`, `/resume-bank/generated`, apply-patches and `lockResume`.
  - The Resume Lab UI refetches its list on it. `App.jsx` refetches `/resume/score` when `primaryId` changes.

## 11. Notifications (only through `notify()`, NOTIFICATIONS.md)

`byok` imports `notify` **lazily** (`await import("../notifications/notify.js")` inside a try/catch). A missing notifications module is a no-op.

| type | when | recipients | title | body | ui | other |
|---|---|---|---|---|---|---|
| `llm.key_invalid` | a saved credential gets 401/403 from its provider (tailor, chat, models with `credentialId` or the saved fallback), or cannot be decrypted | the key owner | `Your {ProviderLabel} key “{label}” stopped working` | `{ProviderLabel} rejected the key or it can no longer be read. Update or remove it in Resume Lab → AI keys.` | `{panel:"settings.ai-keys", params:{provider}}` (UI-ACTIONS §3.2) | `priority:"normal"`, `data:{provider, credentialId}`, `dedupeKey: "llm-key-invalid:<credentialId>:<credential.updatedAt ms>"` (a re-saved key can notify again), `email:false` |

Resume operations are synchronous and need no notifications.

## 12. Agent tools (AGENT-TOOLS.md §2/§5; names are fixed)

All three tools are `roles: ["student"]` and `confirm: false`. They are read-only, never change resumes, and spend only the student's own key. Handlers call the services above. `ctx.user` has no `llmCredentials` (it is re-queried).

**Fuzzy `resume` argument** (resolved by `resolveResumeRef` in `resume.service.js`):
- an owned id;
- `primary`, `main` or `default` → the primary resume; `latest` → the newest;
- otherwise a case-insensitive title contains-match among active resumes;
- several matches → `{ambiguous:true, message:"Which resume?", candidates:[{id, label:"<title> · v<version> · <KIND>"}]}`;
- none → `404 NOT_FOUND {entity:"resume"}`.

| tool (module) | parameters (JSON schema subset) | result |
|---|---|---|
| `resume_list` (resume-lab) | `{includeArchived?: boolean}` | `summary`: "You have {n} resume(s): “{title}” ({KIND}, v{version}{, ATS {score}}){★ primary} …" (≤ 10 listed). `data: {resumes:[{id,title,kind,version,isPrimary,atsScore,updatedAt}], primaryId}`. `ui: {panel:"resume.lab", params:{tab:"catalog"}}`. Zero resumes: "You have no resumes yet. Upload one in Resume Lab or ask me to generate one." with the same `ui` |
| `resume_score` (resume-lab) | `{resume?: string ("Resume id or title; default = primary resume"), job?: string ("Optional job to score against: id from a job search, 'campus:<id>', 'market:<id>' or 'title at company'")}` | `summary`: "“{title}” scores {score}/100 ({grade}){ against {job.title} at {company}}. Top fixes: 1) … 2) … 3) …". `data: {resumeId, score, grade, rubricBreakdown, improvements, missingKeywords, target}`. `ui: {panel:"resume.lab", params:{tab:"ats", resumeId, jobId?, jobSource?}, data: ScoreResult}`. No resume: summary to upload one, `ui: {panel:"resume.lab", params:{tab:"catalog"}}`, `data:{resume:null}` |
| `resume_tailor_for_job` (byok) | `{job: string (required; id from a job search, 'campus:<id>', 'market:<id>' or 'title at company'), resume?: string, credentialId?: string ("Saved key id, provider name (openai/anthropic/google/xai) or key label; default = most recently saved key"), jobDescription?: string ("Only when the student pasted the job description in chat")}` | see the outcomes below |

**`resume_tailor_for_job` outcomes.** The `ui` and `ui.data` follow UI-ACTIONS §10 exactly:
- **ok:**
  - `summary`: "Prepared {n} suggested edit(s) for “{resume}” targeting {job.title} at {company}{ — adds {≤5 keywords}}. Nothing has been changed yet; review and apply them in the Tailor tab." When `appliesTo` is `extracted_text`, append "(suggestions only — your resume is a {PDF/DOCX})". When n = 0: "Your resume already covers this job's key requirements — I found no safe edits."
  - `data: {status:"ok", resumeId, jobId, jobSource, totalPatches, missingKeywordsFound, patches:[{id, section, targetContext, keywordsAdded, reasoning, lineRange}]}`. These compact patches, without the substrings, are the AGENT-TOOLS `data.patches` and keep the LLM context small.
  - `ui: {panel:"resume.lab", params:{tab:"tailor", resumeId, jobId, jobSource, credentialId}, data:{resumeId, jobId, jobSource, credentialId, provider, model, patches /* full Patch[] */, missingKeywordsFound, totalPatches, requiresManualJD:false, sourceHash, revision, appliesTo, skipped}}`.
- **needs_key** (no saved key): an **ok:true** result.
  - `summary`: "Resume tailoring uses your own AI key. Add an OpenAI, Anthropic, Google or xAI key in Resume Lab → AI keys, then ask me again."
  - `data:{status:"needs_key"}`, `ui:{panel:"settings.ai-keys"}`.
- **needs_job_description:** an **ok:true** result.
  - `summary`: "I couldn't find a description for “{job.title}”. Paste the job description here (or in the Tailor tab) and I'll continue."
  - `data:{status:"needs_job_description", jobId, jobSource}`.
  - `ui:{panel:"resume.lab", params:{tab:"tailor", resumeId, jobId, jobSource}, data:{resumeId, jobId, jobSource, requiresManualJD:true, message}}`.
  - A pasted `jobDescription` is passed as `manualJobDescription` with `saveJobDescription: true`.
- **Ambiguous job or resume:** returns the AGENT-TOOLS `{ambiguous:true, …}`.
- **Other `ApiError`s** (`LLM_REFUSED`, `LLM_KEY_INVALID`, …) surface as `{ok:false, error, message}` per AGENT-TOOLS §3.

The tools run synchronously and can take up to `LLM_REQUEST_TIMEOUT_MS` (90 s). See the timeout dependency in §20.

## 13. Alumni share flow (unified model)

The existing flow keeps working unchanged:
1. The Python alumni agent picks `resume_version_id` from `meta_data.resume_bank`, which is `listResumeMetadata(ownerId)` = BankItem fields for **active** resumes of every kind.
2. Node records the review gate (`alumni:resume-share-review`).
3. The frontend posts `POST /api/v1/alumni/connections/:id/share-resume {sessionId, resumeVersionId, message}`.
4. The route finds `Resume.findOne({_id, owner, status:"active"})`. This still works because `owner` and `status` are kept.

Required edits in `backend/src/routes/alumni.routes.js`:
- After `MentorshipMessage.create(...)`, call `await lockResume(resume._id, "alumni-share")`, imported from `../modules/resume-lab/services/resume.service.js`. The shared version can then never change, and edits require "duplicate". Lock failures are logged and do not fail the share.
- `resumeSnapshot` becomes `{title, version, targetJob, kind}`, and the messages `populate("resumeVersion", …)` adds `kind`.

Opening: the student and alumnus click → `GET /resume-bank/:id/access` (§8.2) → `window.open(data.url)`. The signed link serves a PDF (latex/pdf), a `.docx` download, or text.

**Compat exports for Node callers** (`resume.service.js`, re-exported by `services/resume-bank.service.js`):
- `listResumeMetadata(ownerId)` → `BankItem[]` (active, version desc).
- `getLatestResumeForAnalysis(ownerId)` → for the primary resume (else the newest active): `{_id, title, version, targetJob, kind, createdAt, latexCode: source ?? extractedText}`. Python reads `latest_resume.latexCode`, which is plain text for non-LaTeX kinds.
- `saveGeneratedResume({user, latexCode, title, targetJob})` → `{resume: BankItem, created}`.
- `buildPrivateResumeUrl(resume, {viewerId} = {}) → string` stays **synchronous**, like SIH, because PLACEMENTS `GET /applications/:id/resume` calls it.
  - It returns the §8.4 signed link: variant `pdf` for latex/pdf, `original` otherwise; `viewer` = `viewerId ?? "-"`; valid `RESUME_FILE_URL_TTL_SECONDS`.
  - No compile happens here; a latex PDF is compiled when the link is fetched. It no longer throws 503 for missing Cloudinary.

**Exports for other modules** (placements, auth demo reset):
- `getPrimaryResume(ownerId)`: primary, else newest active
- `getResumeForOwner(ownerId, resumeId)`
- `lockResume(resumeId, reason)`: idempotent; `$set lockedAt` if null, `$addToSet lockReasons`, emits `resume:changed{action:"locked"}`
- `buildResumeAccessUrl(resume, {viewerId, variant})`: async, pre-compiles; the caller authorizes first
- `resumeSnapshot(resume)`
- `purgeResumesForUsers(userIds)`: deletes resumes, their stored files and `JobDescriptionOverride`s (for the AUTH-FACULTY demo cascade)
- `resolveJob`, `resolveJobRef`, `resolveJobDescription`
- `scoreResumeById`

## 14. Module wiring, background work

```js
// resume-lab/index.js
export default { name: "resume-lab", mountPath: "/api/v1/resumes", router: resumesRouter,
  routers: [{ path: "/api/v1/resume", router: legacyRouter }, { path: "/api/v1/resume-bank", router: bankRouter }],
  start, tools };            // tools = [resume_list, resume_score]
// byok/index.js
export default { name: "byok", mountPath: "/api/v1/llm", router, start, tools };   // tools = [resume_tailor_for_job]
// Named exports required by JOB-FEED §11.3 / §17 (WhatsApp extraction with a TPO's saved key):
export { decryptApiKey, encryptApiKey, maskApiKey } from "./services/credentials.service.js";
export { GenericLlmClient, listProviderModels } from "./services/llm-client.js";
export { LLM_PROVIDERS, getLlmProvider, normalizeLlmModel } from "./providers.js";
```

`new GenericLlmClient(provider, apiKey, model)` → `.complete(messages, {jsonMode}) → {content, …}` (§9.3). Its errors are `ApiError`s, so they carry `statusCode`, which is what JOB-FEED relies on.

`app.use("/api/v1/resume", …)` does not match `/api/v1/resumes/...` (segment boundary).

**`resume-lab.start()`** runs once after MongoDB connects; each step is try/catch and logged:
1. Run `migrateLegacyResumes()` (§2.4: drops `owner_1_sourceHash_1`, syncs indexes).
2. Remove `os.tmpdir()/mpc-latex-*` directories older than 1 h.
3. If `LATEX_WARMUP_ON_START` (default true; always false when `NODE_ENV=test`) and the binary exists, compile once in the background (non-blocking) a warmup document. It uses the packages of the Python generator and Jake's template (geometry, hyperref, titlesec, enumitem, fontenc, inputenc, xcolor, latexsym, fullpage, marvosym, color, verbatim, fancyhdr, babel[english], tabularx, `\input{glyphtounicode}`), so the Tectonic bundle is cached for offline demos.
4. `registerJob("resume-lab:latex-tmp-sweep", 6 * 3600_000, sweep)`.

**`byok.start()`:** logs one warning when `isByokEnabled()` is false.

There are no other periodic jobs.

## 15. Environment variables

Getters in `resume-lab/config.js` and `byok/config.js` read `process.env` **at call time**.

| name | default | meaning |
|---|---|---|
| `STORAGE_DRIVER` | `local` | driver for **new** files: `local` \| `cloudinary` \| `uploadthing` |
| `UPLOAD_DIR` | `./uploads` (relative to the backend cwd) | local driver root |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | `""` | cloudinary driver, and reading legacy SIH PDFs |
| `CLOUDINARY_RESUME_FOLDER` | `tnp-ai/resumes` | public-id prefix |
| `UPLOADTHING_TOKEN` | `""` | uploadthing driver (read only by the backend) |
| `UPLOADTHING_ACL` | `private` | per-upload ACL (the UploadThing app must allow ACL overrides) |
| `RESUME_MAX_UPLOAD_BYTES` | `5242880` | maximum uploaded file size |
| `RESUME_MAX_SOURCE_BYTES` | `204800` | maximum LaTeX/text source, also the compile cap |
| `RESUME_MAX_PER_USER` | `50` | active resumes per student |
| `RESUME_FILE_URL_SECRET` | HMAC-SHA256(`ACCESS_TOKEN_SECRET`, `"resume-file-url"`) | signs file links |
| `RESUME_FILE_URL_TTL_SECONDS` | `600` | signed-link lifetime |
| `PUBLIC_API_URL` | `""` | absolute API origin for signed links; empty means root-relative `/api/v1/...` |
| `TECTONIC_BIN` | `backend/bin/tectonic` if present, else `tectonic` | compiler binary (this Mac: `/opt/homebrew/bin/tectonic`) |
| `TECTONIC_SKIP_DOWNLOAD` | `false` | skip the Linux postinstall download |
| `LATEX_COMPILE_TIMEOUT_MS` | `60000` | per compile |
| `LATEX_MAX_CONCURRENT` / `LATEX_MAX_QUEUE` / `LATEX_QUEUE_WAIT_MS` | `2` / `8` / `30000` | compile semaphore |
| `LATEX_CACHE_ENTRIES` | `20` | in-memory PDF LRU |
| `LATEX_WARMUP_ON_START` | `true` (forced false in tests) | prefetch the Tectonic bundle at boot |
| `LLM_CREDENTIAL_ENCRYPTION_KEY` | — (required for BYOK) | base64 of 32 random bytes (`openssl rand -base64 32`); changing it makes saved keys `broken` |
| `LLM_REQUEST_TIMEOUT_MS` | `90000` | provider call timeout; must stay below the relay's `AI_IDLE_TIMEOUT_MS` (120000) |
| `LLM_MODELS_TIMEOUT_MS` | `15000` | model listing timeout |
| `LLM_ANTHROPIC_MAX_TOKENS` | `16000` | Anthropic `max_tokens` |
| `LLM_MAX_CREDENTIALS` | `10` | saved keys per user |
| `TAILOR_RATE_LIMIT_PER_HOUR` | `30` | `/tailor` + `/chat` per user |

Matchy's `MAX_RESUME_SIZE_BYTES` is not used.

## 16. Security and privacy rules (must hold)

- **Ownership:** a resume, override or credential of another user is always `404`.
- **Data at rest:** sources and extracted text live only in MongoDB. Files are private: local files, Cloudinary `authenticated`, or UploadThing `private`. They are served only through owner-JWT or HMAC-signed links lasting at most 10 min.
- **LaTeX:** policy + secret scan + env allowlist + `--untrusted` + concurrency limits (§6). The compile `log` returned to clients is the concise, redacted excerpt, never the full transcript.
- **API keys:**
  - only ever appear in request bodies to `/llm/credentials` and `/llm/providers/:p/models`;
  - are stored encrypted, never logged, and never sent to the Python service or put in chat;
  - the frontend must not offer pasting keys into chat.
- **Shared job documents** (`Job`, `ExternalJob`) are read-only for this area.
- **File responses** set `nosniff`, `CSP: sandbox` and `no-store`. Content is sniffed by magic bytes, never trusted from the client MIME type.

## 17. Bugs fixed by this contract (checklist)

**Matchy:**
1. The manual JD was written into a shared `Job` → `JobDescriptionOverride` (§7).
2. Strict `JSON.parse` failed on fenced Anthropic output → `parseJsonLoose`.
3. Anthropic never checked `stop_reason` and joined non-text blocks → §9.3.
4. The retired Anthropic default → `claude-haiku-5-5` + normalization.
5. The Google key sat in the URL → `x-goog-api-key`.
6. Model listing ignored `credentialId`, had no pagination and no timeout → §9.3.
7. `GET /providers` returned 500 on decrypt failure → `broken` + `keyHint`.
8. Compile timeouts reported 400 → 504.
9. The `\\{2,}` rewrite corrupted line breaks → over-escaped mode only.
10. No compile concurrency limit → semaphore and queue.
11. Public `utfs.io` resume URLs → private ACL + signed URLs, with sources moved to MongoDB.
12. An invalid ObjectId caused a 500 → `assertObjectId`.
13. No set-active route, and deleting the active resume left none → primary + promotion.
14. Inconsistent size caps → one 200 KB source cap and a 5 MB upload cap.
15. Patch `endLine` off by one, ids not deduplicated, overlaps undetected → §9.5.
16. The brace check rejected legitimately unbalanced fragments → the brace-delta rule.
17. The `{error}` body and 204 responses → envelope everywhere.
18. Matchy tailoring only knew Matchy jobs → campus and market resolver.

**SIH:**
1. `latexonline.cc` sent PII to a third party and hit HTTP 414 → Tectonic.
2. The Resume Bank hard-depended on Cloudinary (503) → storage drivers, local by default.
3. `/resume/upload` and `/resume/score` were missing → §8.1.
4. The fake 80/75/70/85 rubric → real scores, and the frontend empty state (§18).
5. The resume bank required a `Student` profile → it no longer does.
6. The version race returned E11000/500 → retry.
7. Jake-style resumes failed under XeTeX → shim (§6.2).

## 18. Frontend obligations (the backend contract above is final; these are the minimal client edits)

1. **`frontend/src/App.jsx:133`:** use `setResumeScoreData(scoreResult.value?.data ?? null)`. `api.getResumeScore` returns the envelope. **The frontend changes, not the backend.** Also refetch it on `resume:changed` when `primaryId` changes.
2. **`components/ResumeScoreCard.jsx`:**
   - Remove the hardcoded default rubric and show an empty state when `!scoreData`.
   - Accept `.pdf,.docx,.tex,.txt` (both the type check and the `accept` attribute).
   - "TEST SAMPLE RESUME" calls a new `api.previewResumeScore({text})` (`POST /resume/score/preview`) and shows the result locally. It must never call `/resume/upload`.
   - Show `data.feedback.improvements` and the `breakdown[].detail` lines.
3. **`components/ResumeGeneratorWorkspace.jsx`:**
   - Delete the `latexonline.cc` URL.
   - When `status === "complete"`, call `http.post("/resumes/compile", {latex}, {responseType: "blob", timeout: 90000})` and use `URL.createObjectURL` (revoke the previous URL).
   - Error bodies arrive as a Blob: `JSON.parse(await blob.text())` → `message` / `errors[0]`.
4. **`pages/ResumeStudio.jsx`:** follow the UI-ACTIONS §3.2 tab ids: `catalog` (today's bank and upload), `editor`, `tailor`, `ats`, `generator`, `skill-gap`, plus the separate `settings.ai-keys` panel (`features/resume/AiKeysPanel.jsx`).
   - `appContextSlice.setActiveResumeTool` already accepts any id.
   - **`catalog`** lists `GET /resumes`, uploads via `POST /resumes` (multipart) and offers set-primary, duplicate, archive and restore.
   - **`editor` / `tailor`** port the Matchy editor page from `MFE/pages/resume-editor-page.jsx`:
     - the editor and preview (`POST /resumes/compile {resumeId}` or `{latex}`), and save with `PUT /resumes/:id {content, expectedRevision}`;
     - a job picker over campus and market jobs (`{jobSource, jobId}`) and a key picker from `GET /llm/providers`;
     - a manual JD box kept **per job key** (fixes Matchy's leak), prefilled from `GET /llm/job-descriptions/:jobSource/:jobId`;
     - per-patch accept checkboxes → `POST /resumes/:id/apply-patches` (default `new-version`, then switch to the returned resume);
     - a locked resume shows "Shared — Duplicate to edit" → `POST /resumes/:id/duplicate`;
     - when the panel's `data` holds patches (UI-ACTIONS §10 shape) it renders them without refetching.
   - **`settings.ai-keys`** ports `MFE/pages/configure-keys-page.jsx` onto the §9.4 routes: PATCH to edit, delete with confirmation, list models for a saved key with `{credentialId}`.
   - New ported pages use `http` (`lib/http.js`, which unwraps `data`) in `frontend/src/lib/api/resumes.js` and `frontend/src/lib/api/llm.js`. Timeouts: tailor 120000 ms, compile 90000 ms, upload 60000 ms.
   - Optionally label the bank's "VIEW PDF" by kind.
5. **The `resume.lab` panel** follows UI-ACTIONS §3.2 (that file wins on panel questions).
   - `ats` with `resumeId` / `jobId` renders the panel `data` (a `ScoreResult` from `resume_score`), or else fetches `GET /resume/score?resumeId&jobId&jobSource`.
6. **`AlumniConnect.jsx`:** no change.

## 19. Acceptance tests (`npm test` → `node --test`)

**Shared test setup:**
- Each file imports `./helpers.js` first. Helpers already set `STORAGE_DRIVER=local` and `LLM_CREDENTIAL_ENCRYPTION_KEY`.
- The resume suites set `process.env.UPLOAD_DIR = await mkdtemp(...)` before `getApp()`.
- Tectonic tests use `{skip: !hasTectonic}`, where `hasTectonic` = `spawnSync(TECTONIC_BIN || "tectonic", ["--version"]).status === 0`.
- BYOK tests stub `globalThis.fetch` per test and restore it afterwards.

**`test/ats.test.js` (pure):**
- **A1** The strong fixture (embedded text with every section, email, phone, LinkedIn, 8 bullets of which 5 are quantified, 6 start with action verbs) scores ≥ 80. Two runs are deep-equal apart from `computedAt`. `feedback.rubricBreakdown` has exactly the 4 keys with integers 0–100.
- **A2** Removing the email lowers `score` by exactly 4, `contact.status` becomes `warn`, and an improvement mentions an email.
- **A3** 0/6 quantified bullets → `impact.points === 0`. 3/6 → 15. "Python 3" and "2023 – 2025" are not quantified; "Served 1,200 users" is.
- **A4** `job.skills = ["Docker","Redis","React"]` with a resume mentioning only React → `matched ["react"]`, `missing` contains docker and redis, `skillsMatch === 33`, and the first improvement mentions Docker.
- **A5** A JD containing "go to market" does not add the keyword `go`. "Golang" does.
- **A6** `latexToText` on a Jake-style snippet produces `"• Built …"` bullets and `Experience` as a heading line, with no `\` left.
- **A7** Empty or scanned text (fewer than 50 chars) → `score ≤ 20`, readability fails, and an improvement mentions a scanned PDF.
- **A8** Breadth mode (no job, no profile skills) gives `keywords.source === "breadth"`. Profile mode lists profile skills missing from the resume.

**`test/latex.test.js`:**
- **L1** The policy rejects each of these with `LATEX_FORBIDDEN` and the right `line`:
  - `\input{/etc/hosts}`, `\input{../x}`, `^^5cinput{/etc/hosts}`, `\csname input\endcsname{/x}`
  - `\newread\f \openin\f=/x`, `` \catcode`\|=0 ``, `\let\x\input`
  - `\begin{filecontents}{a}`, `\usepackage{../evil}`, `\documentclass{/tmp/x}`, `\includegraphics{/etc/x.png}`
  - `\special{x}`, `\XeTeXpicfile`, `\immediate\write18{ls}`, `\lstinputlisting{x}`, `\@@input x`
- **L2** The policy accepts every allowed example in §6.3.
- **L3** (tectonic) A minimal document compiles to bytes starting `%PDF-`. A Jake-style preamble with `\input{glyphtounicode}` + `\pdfgentounicode=1` compiles thanks to the shim. An error document reports `errors[0].line` equal to the user's line.
- **L4** `TECTONIC_BIN=/nonexistent` → `503 COMPILER_UNAVAILABLE`. A `\loop\iftrue\repeat` document with `LATEX_COMPILE_TIMEOUT_MS=1500` → `504 LATEX_COMPILE_TIMEOUT`.
- **L5** (tectonic) With a test env var such as `TEST_SECRET=abcdefghijklmnop1234` set and that value written literally in the document body → `422 LATEX_FORBIDDEN`, `construct "secret"`. The value never appears in the response body.
- **L6** Over-escaped normalization: `\\documentclass…\\textbf{x}` compiles. A normal source with `line\\Next` is left unchanged.

**`test/resume-lab.test.js` (supertest):**
- **R1** `POST /api/v1/resume/upload` with multipart `text` → 201: `data.score` is a number, `data.feedback.rubricBreakdown` has 4 keys, `data.resume.kind === "text"`, `isPrimary === true`. `GET /api/v1/resume/score` returns the same `resume._id` and `score`.
- **R2** Uploading the PDF and DOCX fixtures → `kind` pdf/docx with non-empty extracted text (checked through `GET /resumes/:id` → `contentKind "extracted"`). The file exists under `UPLOAD_DIR`. Re-uploading the same PDF → 200 with `created:false`.
- **R3** Rejections:
  - `.doc` OLE bytes → 415
  - UTF-8 text uploaded as `cv.pdf` → 415 (the extension claims a format the bytes don't match)
  - over `RESUME_MAX_UPLOAD_BYTES` (set to 1000 in the test) → 413 `FILE_TOO_LARGE`
  - no auth → 401; teacher → 403
- **R4** No resumes → `GET /resume/score` gives 200 with `data === null`. `POST /resume/score/preview` → 200 with `resume: null`, and `GET /resumes` stays empty.
- **R5** CRUD:
  - create latex → v1 primary; create a second → v2, which becomes primary while v1 is not, with exactly one primary in the DB
  - `GET /:id` returns the `content`
  - another user's id → 404; a bad id → 400
- **R6** Editing:
  - `PUT` content → `revision 2`, `atsScore` updated
  - stale `expectedRevision` → 409 `REVISION_CONFLICT` with `currentRevision`
  - `PUT` content on a pdf → 409 `NOT_EDITABLE`
- **R7** `POST /:id/primary` moves the primary. `DELETE` of the unlocked primary → `{deleted:true, archived:false}`, the file is removed, and the newest remaining resume becomes primary.
- **R8** Locking:
  - after `lockResume(id,"manual")`: `PUT` content → 409 `RESUME_LOCKED`, `PUT` title → 200, `DELETE` → `{archived:true}`, `POST /restore` → active
  - `POST /:id/duplicate` → 201 with version+1, `origin duplicated`, `parentId` set, same content and **no E11000**
- **R9** Apply-patches:
  - two non-overlapping patches → 201 new version, `origin tailored`, `parent` set, and the content contains both replacements
  - an overlapping third → `skipped[{reason:"overlap"}]`
  - a patch with shifted offsets plus a different `baseSourceHash` → relocated
  - a stale `originalSubstring` → skipped `stale`
  - all skipped → 422 `NO_PATCHES_APPLIED`
  - `in-place` on a locked resume → 409
- **R10** Bank compat (with `TECTONIC_BIN=/nonexistent`):
  - `POST /resume-bank/generated {latexCode, title}` → 201 with `pdfStatus "pending"`; the same body again → 200 with the same `_id`
  - `GET /resume-bank` items have `_id, title, version, createdAt` and **no** `source`, `latexCode` or `sourceHash`
- **R11** Signed links:
  - `GET /resume-bank/:id/access` for a text resume → `{url}`; an unauthenticated `GET url` → 200 `text/plain` with the content
  - a tampered `sig` → 403 `INVALID_SIGNATURE`; `exp` in the past → 403 `LINK_EXPIRED`
  - another student's JWT on `/file` without `sig` → 404
  - (tectonic) for a latex resume the URL serves `application/pdf`
- **R12** Alumni flow:
  - with an accepted `AlumniConnection` and `recordResumeShareReview(...)`, the student's `POST /alumni/connections/:id/share-resume` → 201 and the resume becomes `locked`
  - the connected alumnus gets 200 from `GET /resume-bank/:id/access`; an unrelated alumnus gets 403
- **R13** Migration:
  - insert a raw legacy SIH doc (`latexCode`, `sourceHash`, `storage{provider:"cloudinary", publicId}`, no `kind`) plus the legacy unique index, then run `migrateLegacyResumes()`
  - result: `kind latex`, `origin generated`, `source` set, `pdf.driver "cloudinary"`, `dedupeKey` = the old hash, `storage` unset, `owner_1_sourceHash_1` dropped, a primary assigned
  - a second run changes 0 docs
- **R14** Creating a resume emits `resume:changed {action:"created"}` to the owner's socket (via `startTestServer`).
- **R15** Job-targeted score: with a campus `Job` (`skills:["Docker"]`), `GET /resume/score?jobId=<id>&jobSource=campus` → `target.source === "campus"` and `keywords.source === "job"`. The same call with `jobKind=campus` works too. A draft job → 404.
- **R16** Compat helper: `buildPrivateResumeUrl(resume)` returns a **string** synchronously (not a Promise), and fetching it unauthenticated returns the file. `listResumeMetadata` and `getLatestResumeForAnalysis` (through `services/resume-bank.service.js`) return the §13 shapes.

**`test/byok.test.js`:**
- **B1** `PUT /llm/credentials/anthropic {apiKey:"sk-ant-test-1234567890"}` → 201 `maskedApiKey "sk-a••••7890"`, `model "claude-haiku-5-5"`.
  - The raw DB value (`select +llmCredentials`) does not contain the key.
  - `GET /llm/providers` includes the credential, and the JSON body never contains the plain key.
  - `GET /auth/me` has no `llmCredentials`.
- **B2** Saving `model: "claude-3-5-haiku-latest"` or `"claude-3-5-haiku-20241022"` → `"claude-haiku-5-5"`. `normalizeLlmModel("google","gemini-2.5-pro") === "gemini-3.1-pro-preview"`.
- **B3** Anthropic wire format, checked on the stubbed `fetch` during `/tailor`:
  - URL `https://api.anthropic.com/v1/messages`
  - headers `anthropic-version: 2023-06-01` and `x-api-key`
  - body keys are exactly `["max_tokens","messages","model","system"]` with `max_tokens 16000`; no `temperature`, `top_p`, `top_k` or `thinking`
- **B4** Stop reasons:
  - `stop_reason "refusal"` + `stop_details.category "cyber"` → 422 `LLM_REFUSED` with `errors[0].category "cyber"`, and the content is never parsed
  - `"max_tokens"` → 502 `LLM_TRUNCATED`
  - a response with a `thinking` block followed by a `text` block containing ```` ```json …``` ```` → 200 with the patches parsed
- **B5** Manual-JD isolation, using an `ExternalJob` with an empty description (use the job-feed model; define a minimal `ExternalJob` only if it is not registered):
  - Student A tailors it with `manualJobDescription "JD-A …(≥30 chars)"` → 200, and the `ExternalJob` doc is unchanged.
  - Student B without a JD → `requiresManualJD:true` (A's text is not used).
  - A again without a JD → `jobDescriptionSource "saved"`, and the captured prompt contains "JD-A".
  - A on another job → `requiresManualJD:true`.
- **B6** Patch validation, from stubbed LLM suggestions: a hallucinated original → `skipped not_found`; unbalanced braces → `unbalanced_braces`; an overlap → `overlap`; duplicate LLM ids → renumbered `patch_1..n`; a two-line original ending in `\n` → correct `endLine`; `30%` in a LaTeX replacement → `\%` with `autoEscaped`.
- **B7** Credentials and keys:
  - no credential → 422 `LLM_KEY_REQUIRED`; another user's `credentialId` → 404
  - an 11th key → 409 `TOO_MANY_KEYS`
  - `PATCH` label/model → 200
  - `DELETE` one key → `{deleted:1}`
- **B8** Key failures:
  - a provider 401 → 422 `LLM_KEY_INVALID`, and one `Notification{type:"llm.key_invalid"}` exists for the user (skip if the model is not registered); a retry creates no duplicate
  - a tampered `encryptedApiKey` → `/providers` returns 200 with that credential `broken:true`
- **B9** `LLM_CREDENTIAL_ENCRYPTION_KEY` deleted at runtime → `/llm/providers` gives 503 `BYOK_DISABLED`.
- **B10** Models:
  - Anthropic with `has_more:true` then a second page → merged ids, and the second request carries `after_id`
  - Google uses the `x-goog-api-key` header and the URL has no `key=`
  - `{credentialId}` uses that saved key
- **B11** Tools (handlers called directly with `ctx`; also through `/api/v1/agent-tools/execute` when that module exists):
  - `resume_list` → `ui.panel "resume.lab"`, `params.tab "catalog"`
  - `resume_score` → `params.tab "ats"` and `ui.data.score` is a number
  - `resume_tailor_for_job` without a key → ok with `data.status "needs_key"` and `ui.panel "settings.ai-keys"`
  - with a key and stubbed fetch → `params` equals `{tab:"tailor", resumeId, jobId, jobSource, credentialId}`, `ui.data.patches.length > 0` with full `originalSubstring`, and `data.patches` has no `originalSubstring`
  - a job with no description → `ui.data.requiresManualJD === true` with a `message`
  - with a job text matching a campus drive and a market job → `AMBIGUOUS` with `campus:` and `market:` candidate ids
- **B12** `import("../src/modules/byok/index.js")` exposes `decryptApiKey` and `GenericLlmClient` (JOB-FEED). `new GenericLlmClient("openai", "sk-test-123456789", undefined).complete([{role:"user", content:"hi"}])` with stubbed fetch → `{content}`. A stubbed 401 rejects with an error whose `statusCode === 422` and code `LLM_KEY_INVALID`.

No Python changes, so no pytest for this area.

## 20. Cross-area dependencies

1. **JOB-FEED.md:**
   - This area uses `getExternalJob(id)` and `resolveMarketJob(ref, {user})` from `backend/src/modules/job-feed/feed.service.js` (lazy import), and reads `PublicExternalJob.{id, title, company, location, applyUrl, description}`. It never writes `ExternalJob`.
   - It provides the named exports `decryptApiKey` and `GenericLlmClient` from `byok/index.js` (§14) that JOB-FEED §11.3 needs.
   - `jobs_search_market` items expose `id`, which tools pass as `job`.
2. **PLACEMENTS.md:**
   - This area reads `mongoose.models.Job` (`title`, `description`, `company`→`Company{name}` or `companyName`, `skills[]`, `status`, `applicationUrl`) and `services/scope.js#jobScope` (lazy).
   - `buildPrivateResumeUrl()` stays exported from `services/resume-bank.service.js`, synchronous and string-returning (§13), so `GET /applications/:id/resume` keeps working. It no longer returns 503 for a missing Cloudinary setup.
   - `Resume` keeps `owner`, `status:"active"`, `title` and `version`, so `application.service.js#resolveStudentResume` needs no change.
   - **Requested:** default the apply resume to `getPrimaryResume()` instead of "latest version", and call `lockResume(id, "application")` after a successful apply, so recruiters see the exact submitted version.
3. **AGENT-TOOLS:**
   - Argument extensions (optional): `resume_score.job`, `resume_tailor_for_job.jobDescription`.
   - The tools' `ui`/`data` follow UI-ACTIONS §10. `ui.data` must be forwarded into `ui_actions[].data`.
   - The copilot's `/execute` HTTP timeout must be **≥ 110 s** (tailoring can take up to 90 s).
   - Routing: `backend/src/websocket/intent-router.js` currently sends student "resume + tailor/score/match" phrasing to `resume-generator`. To honour AGENT-TOOLS ("resume scoring/tailoring → copilot"), the routing owner must send "tailor my resume for <job>" and "score my resume" to the copilot, and keep "create/build/generate a resume" with the generator.
4. **NOTIFICATIONS:** add the type `llm.key_invalid` (muted by the prefix `llm`).
5. **UI-ACTIONS:**
   - Add the §11 row `llm.key_invalid` → `{panel:"settings.ai-keys", params:{provider}}`.
   - The `resume.lab` `ats` tab accepts `data` = `ScoreResult` (optional, from `resume_score`).
   - The frontend obligations are in §18. `App.jsx` stores `.data`.
6. **AUTH-FACULTY.md** (demo reset cascade): replace the raw `Resume` deleteMany with `purgeResumesForUsers(userIds)` (§13), which also removes stored files and `JobDescriptionOverride` rows.
7. **Core:**
   - `.env.example` entries (§15), `.gitignore` (`uploads/`, `bin/`), `package.json` scripts
   - the `User.llmCredentials[].keyHint` field
   - `app.js` drops the resume-bank mount
   - the socket event name `resume:changed` is reserved
8. **Python:**
   - `meta_data.resume_bank` items gain `kind` and `isPrimary`.
   - `meta_data.latest_resume.latexCode` may hold plain text for PDF/DOCX/text primaries.
   - No code change is required; the alumni agent and the analysis keep working.
9. **ALUMNI** (if another area edits `alumni.routes.js`): keep the `lockResume` call and the `kind` in the snapshot from §13.

## 21. Open questions (product owner)

1. Should the college pay for tailoring when a student has no key, via a server Gemini key as an optional fallback with a daily per-student cap? This contract is BYOK-only.
2. Should TPO or company users see student resumes outside applications (for example, a talent search)? Here they do not.
3. Lock-on-share and lock-on-apply (copy-on-write: edits require "Duplicate") versus letting edits flow to mentors and recruiters. This contract locks.
4. Retention:
   - Unlocked deletes are permanent (files included), while locked resumes are archived forever.
   - Pasted JDs expire after 180 days.
   - Is that acceptable for the college's data policy?
5. "Score my resume" in chat: the copilot's deterministic `resume_score` versus the Python resume agent's LLM analysis panel. Pick one default, so the two scores (and their different 0–100 scales) are not shown for the same request.
