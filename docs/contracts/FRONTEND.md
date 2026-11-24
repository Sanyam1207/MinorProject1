# Contract — Frontend integration (Matchy Campus web app)

Scope: everything under `frontend/`. The panel registry, UI-action shape and `applyUiActions` algorithm are in
**UI-ACTIONS.md** (part of this contract). Backend/agent contracts consumed: ATTENDANCE.md, NOTIFICATIONS.md,
AGENT-TOOLS.md, JOB-FEED.md (present when this was written), PLACEMENTS.md, RESUME-BYOK.md, AUTH-FACULTY.md
(written in parallel; absent when this was written).

**Precedence.** (1) UI-ACTIONS.md wins on panel ids, params and targets. (2) The backend contract that owns an
endpoint wins on its path, body and response shape: every path marked **VERIFY** below must be checked against
the named contract before coding; if it differs, use the contract's path and keep this file's function NAME and
RETURN shape by normalizing inside the API module, so components never change. (3) This file wins on file
layout, ownership, component props, Redux state and UX rules.

Frontend roles (agents working in parallel): **shell**, **attendance-teacher**, **attendance-student**,
**opportunities**, **resume**, **tpo**.

---

## 0. Baseline (verified in the repo on 2026-11-24)

- Installed and usable, no new packages needed: React 19.2.8, react-router-dom 7.18.6, @reduxjs/toolkit 2.12,
  react-redux 9.3, Tailwind 4.3.3 via @tailwindcss/vite, Vite 8.2 with the React Compiler preset, axios 1.19,
  socket.io-client 4.8.3, react-hot-toast 2.6.1, qrcode 1.5.4 (`toCanvas`/`toDataURL`), jsqr 1.4.0,
  lucide-react 1.33.0, react-markdown 10.1 + remark-gfm 4.0.1, @react-oauth/google 0.13.5. Every lucide icon
  named in this file exists in 1.33.0.
- `npm run build` passes (one ">500 kB chunk" warning, acceptable). `npx eslint .` currently fails: 40 errors /
  3 warnings in 14 files (§16 assigns each).
- Seams that exist and MUST be used: `src/lib/http.js` (`http` axios instance, unwraps the envelope to `data`,
  single-flight 401 refresh through `POST /auth/refresh-token` with the cookie, rejects with
  `ApiClientError {status, code, message, details}`, fires window events `auth:token-refreshed` / `auth:expired`;
  `errorMessage(error, fallback)`); `src/lib/realtime.js` (`useSocketEvent`, `emitWithAck`,
  `useOnSocketConnect`, `useSocketConnected`); `src/lib/socket.js` (`socket`, `ensureSocketAuthentication`);
  `src/lib/polyfills.js` (first import of `main.jsx`; polyfills `crypto.randomUUID` on insecure origins).
- `VITE_API_BASE_URL` empty = same origin: Vite proxies `/api` and `/socket.io` to `VITE_DEV_BACKEND_URL`
  (default `http://127.0.0.1:8000`). `npm run cert` + `npm run dev:lan` serve HTTPS on the LAN for phones.
- Lint rules that are **errors** (eslint-plugin-react-hooks 7, verified with probes): `set-state-in-effect`
  (synchronous `setState` in an effect body; setState inside `.then`, timers and event handlers is fine),
  `purity` (`Date.now()`/`Math.random()` during render), `refs` (`ref.current` read during render),
  `immutability` (calling a function declared later inside an effect), `static-components`, `error-boundaries`,
  `rules-of-hooks`. `react-refresh/only-export-components` warns when a `.jsx` exports non-components.

## 1. Ground rules (every frontend agent)

1. Edit only files you own (§2). Other owners' files may be imported read-only, and only the exports listed in
   §11 / §14.
2. No new npm dependencies. `package.json` / `package-lock.json` belong to shell; the only change allowed in
   this wave is the `test` script (§18).
3. **Stubs first.** Before anything else, create every file you *provide* (§11, §14) with its exact default /
   named exports as a compiling stub (a stub component returns
   `<section className="card-stark bg-white p-6 text-xs font-black uppercase">Coming soon</section>`).
   attendance-teacher writes `src/lib/api/attendance.js` with all exports of §14.4 in its first step.
4. HTTP only through `http` from `src/lib/http.js`, called from an API module in `src/lib/api/`. Components
   never call `http`/axios/fetch directly. API modules return the documented normalized shapes and let
   `ApiClientError` propagate; components branch on `error.code`.
5. Realtime only through `src/lib/realtime.js` / `src/lib/socket.js`.
6. Changing the workspace only through `openPanel()` / `usePanel()` / `switchMode()` (UI-ACTIONS.md §6–7).
   Only shell dispatches `setUserMode`, `setActiveFeature`, `setActiveJobsTab`, `setActiveResumeTool`.
7. Never `alert()`, `confirm()`, `prompt()`: use `toastSuccess` / `toastError` and `<ConfirmDialog>` (§11.3).
8. Pure logic (API modules, normalizers, reducers, parsers, registries) goes in `.js` files with no JSX, with
   explicit `.js` extensions on relative imports, and no top-level access to `window`, `document` or
   `localStorage` (use `src/lib/storage.js` or guard with `typeof window !== "undefined"`). This keeps it
   importable by `node --test`.
9. `src/lib/api.js` (file) and `src/lib/api/` (folder) coexist; Vite resolves `./lib/api` to the file. Never
   create `src/lib/api/index.js`; import folder modules by full name, e.g. `../../lib/api/attendance.js`.
10. Follow the design system (§15) and mobile rules (§15.6). Keep helpers/hooks out of `.jsx` files.
11. Before finishing: `npm run lint` shows 0 errors in your files, `npm run build` passes, your `node --test`
    files pass (§18).

## 2. File ownership (exhaustive — every file has exactly one owner)

| Path under `frontend/` | Owner | Notes |
|---|---|---|
| `index.html`, `vite.config.js`, `eslint.config.js`, `package.json`, `package-lock.json`, `.env.example`, `.gitignore`, `README.md`, `scripts/*` | shell | `vite.config.js`: keep the proxy/LAN/HTTPS setup as is |
| `public/sw.js` (new), `public/manifest.webmanifest` (new), `public/favicon.svg` (replace), `public/icons.svg` (delete), `public/interview-pcm-worklet.js` (unchanged) | shell | |
| `src/main.jsx`, `src/App.jsx`, `src/index.css`, `src/App.css` (delete), `src/assets/*` (delete; unused) | shell | |
| `src/store/index.js`, `src/store/appContextSlice.js`, `src/store/aiChatSlice.js` | shell | |
| `src/services/aiRequestHandler.js`, `src/services/aiFeatureRegistry.js` | shell | |
| `src/lib/api.js`, `src/lib/socket.js`, `src/lib/polyfills.js`, `src/lib/http.js` and `src/lib/realtime.js` (import lines only), `src/lib/config.js` (new), `src/lib/storage.js` (new) | shell | |
| `src/lib/api/auth.js`, `src/lib/api/notifications.js`, `src/lib/api/issueReports.js` (new) | shell | |
| `src/workspace/*` (new), `src/ui/*` (new) | shell | |
| `src/features/auth/*`, `src/features/notifications/*`, `src/features/help/*` (new) | shell | |
| `src/components/{Chat,HeaderBar,ModeDropdown,WelcomeModeSelect,SidebarDrawer,AuthScreen,GoogleAuthButton,ProfileModal,AccessDeniedView,GgsipuConnect,InterviewWorkspace,LearningRecommendationWorkspace,RecommendedResources,VoiceInterviewInput}.jsx` | shell | the last six are assigned to shell by this contract |
| `src/components/StudentGgsipuLogin.jsx` | shell | delete (orphan, calls an undefined API) |
| `src/pages/{StudentMode,AdminMode,PROutreach,AlumniConnect}.jsx` | shell | |
| `test/helpers/*`, `test/workspace.*.test.js`, `test/shell.*.test.js` | shell | new |
| `src/pages/TeacherMode.jsx`, `src/features/attendance/teacher/*`, `src/lib/api/attendance.js`, `test/attendance-api.test.js`, `test/attendance-teacher.*.test.js` | attendance-teacher | |
| `src/features/attendance/student/*` (incl. `AttendPage.jsx`), `test/attendance-student.*.test.js` | attendance-student | imports `src/lib/api/attendance.js` read-only |
| `src/features/opportunities/*`, `src/lib/api/placements.js`, `src/lib/api/jobFeed.js`, `src/components/{DriveGrid,DriveCard,StudentOffers,TrainingHub,PlacementCalendar}.jsx`, `test/opportunities.*.test.js` | opportunities | |
| `src/features/resume/*`, `src/lib/api/resumes.js`, `src/lib/api/llm.js`, `src/pages/ResumeStudio.jsx`, `src/components/{ResumeScoreCard,ResumeGeneratorWorkspace}.jsx`, `test/resume.*.test.js` | resume | |
| `src/features/tpo/*`, `src/pages/CompanyMode.jsx`, `src/components/{OfferManagement,PolicyConfigPanel,TrainingScheduler,GapAnalysisPanel}.jsx`, `src/lib/api/admin.js`, `test/tpo.*.test.js` | tpo | |
| `dist/`, `node_modules/`, `.cert/` | nobody | generated / gitignored |

## 3. Architecture

```
main.jsx: polyfills → store → aiRequestHandler.initialize(store) → bindUiActions(store)
          → store.dispatch(bootstrapSession()) → auth:expired listener → render:
  <StrictMode><Provider store><BrowserRouter>[<GoogleOAuthProvider> only if VITE_GOOGLE_CLIENT_ID]
      <App/><Toaster/> </…></BrowserRouter></Provider></StrictMode>

App.jsx  <Routes>
  "/"                       AppShell (shell): session gate → HeaderBar + [Chat | Workspace] + OverlayHost + SidebarDrawer
  "/attend"                 AttendPage (attendance-student) — wraps itself in <RequireAuth roles={["student"]}>
  "/present/:sessionId"     PresenterPage (attendance-teacher) — <RequireAuth roles={["teacher","tpo","admin"]}>
  "/reset-password/:token"  ResetPasswordPage (shell, public)
  "/report-issue"           ReportIssuePage (shell, public)
  "*"                       <Navigate to="/" replace />

Workspace (right column) = mode page for appContext.activeMode
  student→StudentMode  resume→ResumeStudio  pr_outreach→PROutreach  alumni_connect|alumni→AlumniConnect
  teacher→TeacherMode  tpo→AdminMode        company→CompanyMode
Each mode page renders its panel from activeFeature / activeJobsTab / activeResumeTool (UI-ACTIONS.md §3).
Every workspace change = UI action → applyUiActions() → appContext.panelOpened.
```
Redux slices: `appContext` (extended), `aiChat` (extended), `session` (new), `notifications` (new). The route
components are `React.lazy` + `<Suspense fallback={<LoadingState/>}>`; mode pages stay lazy as today.

## 4. Roles, modes and the header

### 4.1 `src/workspace/modes.js` (shell) — single source (replaces both `allowedModes` copies)

```js
export const ROLE_MODES = Object.freeze({
  student: ["student", "resume", "pr_outreach", "alumni_connect"],
  teacher: ["teacher"],
  tpo:     ["tpo", "pr_outreach"],
  admin:   ["tpo", "pr_outreach"],
  company: ["company"],
  alumni:  ["alumni"],
});
export const MODE_DEFS = Object.freeze({   // icon = lucide icon NAME (mapped by src/workspace/icons.js)
  student:        { id: "student",        label: "Student Mode",     badge: "Placements & attendance", icon: "GraduationCap", home: "student.home",  description: "Jobs, applications, offers, training, attendance and your class schedule" },
  resume:         { id: "resume",         label: "Resume Lab",       badge: "LaTeX + AI",              icon: "Files",         home: "resume.home",   description: "Resume catalog, editor, AI tailoring, ATS score and generator" },
  pr_outreach:    { id: "pr_outreach",    label: "PR & Outreach",    badge: "AI mail workspace",       icon: "Mail",          home: "pr-outreach",   description: "Draft, review and send professional outreach" },
  alumni_connect: { id: "alumni_connect", label: "Alumni Connect",   badge: "Mentorship",              icon: "Users",         home: "alumni",        description: "Find alumni mentors and manage requests" },
  alumni:         { id: "alumni",         label: "Alumni Portal",    badge: "Mentor workspace",        icon: "Users",         home: "alumni",        description: "Review requests and mentor students" },
  teacher:        { id: "teacher",        label: "Teacher Mode",     badge: "Faculty workspace",       icon: "Presentation",  home: "teacher.home",  description: "Courses, class schedule, live QR attendance and reports" },
  tpo:            { id: "tpo",            label: "College TPO Mode", badge: "Placement cell",          icon: "ShieldCheck",   home: "tpo.home",      description: "Drives, applicants, offers, policy, analytics and faculty" },
  company:        { id: "company",        label: "Recruiter Mode",   badge: "Company",                 icon: "Building2",     home: "company.home",  description: "Post drives and review applicants" },
});
export const allowedModesFor = (role) => ROLE_MODES[role] ?? ROLE_MODES.student;  // unknown role = student
export const defaultModeFor  = (role) => allowedModesFor(role)[0];
export const isModeAllowed   = (role, mode) => allowedModesFor(role).includes(mode);
export const needsModeChoice = (role) => (ROLE_MODES[role] ? role === "student" : true);
```
- Login: `activeMode = defaultModeFor(role)`, `isModeChosen = !needsModeChoice(role)` (teacher → TeacherMode
  directly; company → CompanyMode directly — fixes the old company→AccessDenied path).
- Boot: if the stored `activeMode` is not allowed for the user's role, reset it to `defaultModeFor(role)`
  silently (stale storage must never show AccessDenied).
- `switchMode(mode)` (exported by `src/workspace/uiActions.js`): `openPanel(MODE_DEFS[mode].home)`, then
  `setAgentMode(mode === "pr_outreach" ? "pr_outreach" : mode === "alumni_connect" ? "alumni-connect" : null)`.

### 4.2 Components (shell)
- **HeaderBar** `({ activeMode, setActiveMode, user, onOpenDrawer })` — brand box with the initials of
  `APP_NAME` + `<h1>{APP_NAME}</h1>` + subtitle `user?.collegeName || "Placements · Attendance · Careers"`
  (removes the hardcoded "TNP.AI / IPU Placement Platform / GGSIPU" branding); `<ModeDropdown/>`;
  `<NotificationBell/>` (§9) left of the MENU button. Phone layout (< sm): row 1 = brand + bell + MENU (icon
  only), row 2 = full-width mode selector; `sticky top-0 z-40`.
- **ModeDropdown** `({ activeMode, setActiveMode, userRole })` — options = `allowedModesFor(userRole)` from
  `MODE_DEFS`; when only one mode is allowed render a static "CURRENT MODE" box (no popover). `w-full sm:w-72`.
- **WelcomeModeSelect** `({ user, onModeSelected })` — shown only when `!session.isModeChosen`. One card per
  `allowedModesFor(user.role)` (students: Student Mode, Resume Lab, PR & Outreach, Alumni Connect). Each card is a
  single `<button>` (no nested buttons). Remove the fake "REQUEST ACCESS" flows and the badges
  "@IPU.AC.IN DOMAIN", "STEP 2 OF 2", "PERMISSIONS REVIEW ENFORCED", the "ALEX RIVERA" fallback.
- **AccessDeniedView** `({ user, attemptedMode, onReturnToApprovedMode })` — title
  `ACCESS DENIED: {MODE_DEFS[attemptedMode]?.label ?? attemptedMode}`; copy names the real role; one button
  "RETURN TO {MODE_DEFS[defaultModeFor(role)].label}". No fake request button.

## 5. Routes and the attendance deep link

| Route | Component (owner) | Auth | Behaviour |
|---|---|---|---|
| `/` | `AppShell` in `src/App.jsx` (shell) | session gate | `checking` → full-page `LoadingState`; `anonymous` → `AuthScreen`; `authenticated` → welcome (if `!isModeChosen`) or the shell. Applies `?panel=` deep links after authentication (UI-ACTIONS.md §9). |
| `/attend?s=<sessionId>&t=<token>&v=<n>` | `features/attendance/student/AttendPage.jsx` `AttendPage` (attendance-student) | `RequireAuth roles={["student"]}` | §13.2 |
| `/present/:sessionId` | `features/attendance/teacher/PresenterPage.jsx` `PresenterPage` (attendance-teacher) | `RequireAuth roles={["teacher","tpo","admin"]}` | §13.1 |
| `/reset-password/:token[?invite=1]` | `features/auth/ResetPasswordPage.jsx` `ResetPasswordPage` (shell) | public | new password + confirm (≥ 8 chars, must match) → `resetPassword(token, password)` → "Password updated" + "SIGN IN" link to `/`. `invite=1` → title "ACTIVATE YOUR FACULTY ACCOUNT". 400 → "This link is invalid or has expired. Ask for a new one." |
| `/report-issue[?from=<url>]` | `features/help/ReportIssuePage.jsx` `ReportIssuePage` (shell) | public | `ReportIssueForm` (§9.6) full page, prefilled from the session user when logged in |
| `*` | `<Navigate to="/" replace />` | – | |

`RequireAuth` (shell, §11.2): `checking` → loader; `anonymous` → `<AuthScreen title subtitle/>` rendered **in
place** (the URL, including `s`/`t`, is kept); after login the children render; authenticated with a role not in
`roles` → a card "This page is for {roles}. You are signed in as {role}." + "GO TO APP" (`/`).

**Attendance QR flow (must hold):**
1. Logged-in student opens the QR link → `AttendPage` submits `{sessionId: s, token: t, deviceId, geo?}` once and
   shows the result (no extra tap).
2. Logged-out student → sign-in screen titled "SIGN IN TO MARK ATTENDANCE" with the note "Stay signed in on this
   phone so the next scan takes one second." → after login the page submits automatically. If the answer is
   `410 TOKEN_EXPIRED` (expected: tokens rotate every `qrRotationSeconds` and are single-use) the page shows
   **"THIS QR CODE EXPIRED WHILE YOU WERE SIGNING IN. SCAN THE CODE ON THE SCREEN AGAIN."** with a primary
   "SCAN AGAIN" button that opens the in-page camera scanner (§13.2), plus "OPEN MY ATTENDANCE".
3. After the first attempt the page replaces the URL with `/attend?s=<sessionId>` so a reload never resubmits a
   spent token.

Production hosting must serve `index.html` for every non-asset path (`/attend`, `/present/:id`,
`/reset-password/:token`, `/report-issue`); Vite dev/preview already do.

## 6. Session and authentication (shell)

### 6.1 State — `src/features/auth/sessionSlice.js`, mounted as `state.session`
```js
{ status: "checking" | "authenticated" | "anonymous", isModeChosen: boolean, offline: boolean, endedReason: null | "logout" | "expired" }
// initial: status = storage token ? "checking" : "anonymous"; isModeChosen = storage "isModeChosen" === "true"
actions: sessionStarted({ user, conversation, initialMode, isModeChosen }), sessionRestored({ user, offline }),
         sessionAnonymous(), sessionEnded({ reason }), modeChosen()
```
`sessionStarted` and `sessionEnded` are also handled (via `extraReducers`) by `appContext` (user, role,
`activeMode`, `activePanel`, panel state reset), `aiChat` (`sessionStarted` → hydrate `conversation`;
`sessionEnded` → same as `resetAIChat`) and `notifications` (reset). One dispatch = one consistent state, so the
chat-history persister never writes one user's chat under another user's key (old hydration-order bug).

### 6.2 Thunks — `src/features/auth/session.js`
- `bootstrapSession()` — no token → `sessionAnonymous()`. Else `getMe()` (http refreshes once on 401):
  success → `sessionRestored({user})`, persist `user`, `ensureSocketAuthentication()`, `fetchUnreadCount()`,
  register the push service worker silently if permission is already `granted` (§9.4); `ApiClientError` with
  `status === 401` → `logout({reason:"expired"})`; network error (`status === 0`) → `sessionRestored({ user:
  cachedUser, offline: true })` when a cached user exists, else `sessionAnonymous()`.
- `completeLogin({ user, accessToken })` — throws if `user` or `accessToken` is missing (removes the old client
  fallback that invented a user with the requested role). Stores `token`, `user`, `isAuthenticated`,
  `isModeChosen`; dispatches `sessionStarted({ user, conversation: readConversationForUser(user), initialMode:
  defaultModeFor(user.role), isModeChosen: !needsModeChoice(user.role) })`, `ensureWelcomeMessage({ name:
  user.name, role: user.role })`; calls `ensureSocketAuthentication()` (socket rejoins `user:<id>`);
  `fetchUnreadCount()`.
- `logout({ reason = "logout" } = {})` — best effort, in this order, each in its own try: `disablePush()` for
  this device (§9.4), `logoutRequest()`; then remove storage keys `token`, `user`, `isAuthenticated`,
  `isModeChosen`, `activeMode`; dispatch `sessionEnded({reason})`; `ensureSocketAuthentication()` (anonymous
  reconnect leaves the user room); `reason === "expired"` → `toastError("Your session expired. Please sign in again.")`.
- `refreshCurrentUser()` — `getMe()` → `setUserContext(user)` + persist (used by ProfileModal, PR outreach Gmail
  connect, GGSIPU sync).
- `main.jsx` adds `window.addEventListener("auth:expired", () => store.dispatch(logout({ reason: "expired" })))`.
- `useSession()` (`src/features/auth/useSession.js`) → `{ status, user, role, isAuthenticated, isModeChosen }`.

### 6.3 AuthScreen (shell) `({ title?, subtitle?, onAuthSuccess? })`
- Role segmented control (`grid-cols-3 sm:grid-cols-5`): STUDENT `student`, FACULTY `teacher`, TPO `tpo`,
  ALUMNI `alumni`, RECRUITER `company`. Sends `loginOrRegister({ email, password, role })` → `completeLogin`
  → `onAuthSuccess?.(user)`.
- Remove the hardcoded `@ipu.ac.in` check (the server validates college domains). Footer copy per role:
  student "New student emails register automatically (your college domain must be registered).", teacher
  "Faculty accounts are created by your TPO — use the invite email to set your password.", company
  "Recruiter accounts are created by the placement cell.", tpo/alumni keep today's copy.
- On a role-mismatch error (code `ROLE_MISMATCH` with `details.role`, or the legacy message "This email is
  registered as a <role> account") show the message and a button "CONTINUE AS <ROLE>" that switches the tab.
- "FORGOT PASSWORD?" toggles `ForgotPasswordForm` (`src/features/auth/ForgotPasswordForm.jsx`): email →
  `forgotPassword(email)` → always "If an account exists for that email, a reset link has been sent."
- Google: `<GoogleAuthButton role={role} />` rendered only when `GOOGLE_CLIENT_ID` is set.
- Copy uses `APP_NAME`; no "TNP.AI"/"IPU" strings.

### 6.4 GoogleAuthButton (shell) `({ role, onSuccess? })`
`<GoogleLogin onSuccess={({credential}) => googleLogin({ credential, role })} />` → `completeLogin`. Delete the
"1-click demo" simulated logins and the undefined `api.studentGoogleLogin` / `api.companyGoogleLogin` calls.

### 6.5 ProfileModal (shell) `({ user, onClose, onProfileUpdated, initialTab? })`
Rendered by the `profile` overlay. Variants by role:
- student: existing tabs + "General" gains Roll number (`rollNumber`), Section (`section`, uppercased),
  Semester (`semester`, 1–12) used by attendance auto-enroll; Certifications gain `date` and `credentialUrl` inputs.
- teacher: Name, Department (`department`), Designation (`designation`), Employee ID (`employeeId`).
- tpo/admin/company/alumni: Name only (alumni details stay in the Alumni Portal).
Save → `updateMe(patch)` → `onProfileUpdated(user)` (App: `setUserContext` + persist) → `toastSuccess`; errors →
`toastError` (no `alert`).

## 7. Store changes (shell)

### 7.1 `appContext` — additions (existing fields and actions keep their names)
```js
activePanel: MODE_DEFS[activeMode]?.home ?? "student.home",
panelParams: {}, panelData: {}, panelNonce: {},      // keyed by panel id (UI-ACTIONS.md §6)
overlay: null,                                        // "notifications" | "profile" | "report-issue" | null
mobilePane: "workspace",                              // "chat" | "workspace" (< lg only)
workspaceAttention: false, lastUiAction: null,
```
- New reducers: `panelOpened`, `panelParamsUpdated({panelId, params, replace})`, `panelDataCleared(panelId)`,
  `overlayClosed()`, `mobilePaneChanged(pane)` (opening `workspace` clears `workspaceAttention`).
- `setActiveJobsTab(tab)` accepts `matched | campus | market | tracker | detail`; legacy `available` → `campus`;
  anything else → `matched`.
- `setUserContext` also stores `rollNumber, section, semester, department, designation` in `details`.
- Exported selectors (read-only for every owner): `selectUser`, `selectUserRole`, `selectActiveMode`,
  `selectActiveFeature`, `selectActiveJobsTab`, `selectActiveResumeTool`, `selectActivePanel`, `selectOverlay`.
- Module-scope storage reads go through `src/lib/storage.js` (`getItem`, `setItem`, `removeItem`, `getJSON`,
  `setJSON`; all wrapped in try/catch and safe when `localStorage` is missing).

### 7.2 `aiChat` — changes
- Message fields added (persisted with messages): `toolCalls: [{id, name, args, status, summary, error}]`,
  `uiActions: [{id, panel, params}]` (no `data`), `pending: {tool, args, preview} | null`, `copilotPhase`.
- `responseReceived` copilot branch (headers starting with `copilot:`): `message.text = response ||
  data.message || message.text || FALLBACK`; replace `toolCalls` / `uiActions` with the cumulative arrays from
  `data`; `pending = header === "copilot:confirm" ? data.pending : null`; `options = payload.options ||
  data.options` when non-empty; `latestUiTarget = "copilot"`.
- `requestFailed` additionally turns `toolCalls` with status `running` into `{status:"error", error:"Interrupted"}`.
- Hydration (`readStoredConversation`, `readConversationForUser`, `conversationHydrated`, `conversationOpened`):
  every message gets `streaming:false` and running tool calls become `error`/"Interrupted" (fixes the forever
  pulsing bubble).
- `newChatStarted` and `conversationOpened` also reset `learningWorkspace` (AGT-6).
- `mode:jobparser:jobdetails`: `journey.selectedJob = data.selected_job ?? (data?.type === "job_details" ? data.job : data?.title ? data : journey.selectedJob)`.
- `mode:jobparser:jobslist` stores `latestJobs = data` only for a non-empty array (unchanged; items now follow
  JOB-FEED.md §12.5). `mode:jobparser:addjob:wishlist` with `data.type === "wishlist" && data.ok && data.job_id` →
  set `application_status = data.status` on the matching `latestJobs` item (the AI-matched card shows it).
- `interview-history` storage key becomes `interview-history:<userId|email|guest>`; on first read fall back to the
  old global key.
- `ensureWelcomeMessage(arg)` accepts a name string or `{ name, role }`; the welcome text is
  "Hello {name}! I'm your {APP_NAME} copilot. How can I help?" and it carries `options` suggestions:
  student ["Show my attendance", "Find campus drives for me", "Tailor my resume for a job"], teacher
  ["Schedule DBMS tomorrow at 10am", "Start attendance for my next class", "Who is below 75% in my courses?"],
  tpo/admin ["Show placement stats", "List active drives", "Offers awaiting response"], company ["List my drives"],
  alumni ["Show my mentorship requests"].
- All existing selectors and actions keep their names; others may import (read-only): `selectLatestJobs`,
  `selectStudentJourney`, `journeyJobSelected`, `selectResumeWorkspace`, `selectGapAnalysisWorkspace`,
  `selectAILoading`, `selectInterviewWorkspace`, `selectJobCreationWorkspace`.

### 7.3 `store/index.js`
Registers `session` (§6.1) and `notifications` (§9.2) next to `appContext` and `aiChat`; the chat-history
persister is unchanged except that it uses `src/lib/storage.js`.

## 8. Chat and copilot (shell)

### 8.1 Query payload (client → Node `query`)
Unchanged fields plus `details.ui_context = { mode: activeMode, panel: activePanel, params: panelParams[activePanel] ?? {} }`.
`mode_name` = explicit `modeName` || (`activeMode === "pr_outreach"` → `"pr_outreach"`; `"alumni_connect"` →
`"alumni-connect"`) || sticky `agentMode` || (`activeMode === "teacher"` → `"copilot"`) || `null`.

### 8.2 `AGENT_MODE_BY_HEADER` (complete; every existing entry kept)
| headers | agentMode |
|---|---|
| `copilot:thinking`, `copilot:tool`, `copilot:answer`, `copilot:confirm`, `copilot:error` | `copilot` |
| `mode:switch:jobs`, `mode:jobparser:jobslist` | `jobs-finder` |
| `mode:switch:resume`, `resume_generator`, `resume-generator` | `resume-generator` |
| `mode:switch:job-eligibility`, `mode:jobparser:eligibility` | `job-eligibility` |
| `mode:switch:job-creation`, `mode:jobCreation:data`, `:ready`, `:post`, `:error` | `job-creation` |
| `mode:switch:pr-outreach`, `mail:review`, `pr_outreach_satisfied`, `pr_outreach_completed` | `pr_outreach` |
| `mode:switch:alumni-connect`, `alumni_connect`, `alumni:matches`, `alumni:request-review`, `alumni:resume-share-review`, `alumni_connect_completed` | `alumni-connect` |
| `mode:switch:ai-interviewer`, `button:options`, `select:job:db`, `text:mode:interview`, `interview:end` | `ai-interviewer` |
| `mode:switch:gap-analysis`, `mode:gapAnalysis:analysis`, `:suggestions`, `:error` | `gap-analysis` |
| `mode:switch:learning-recommendation`, `select:interview:db`, `learning:recommendations`, `learning:recommendations-error` | `learning-recommendation` |
After hydrating or opening a stored conversation, `agentMode` = `AGENT_MODE_BY_HEADER[last bot message's
headerMessage] ?? null`, so "Confirm" after a reload still reaches the copilot.

### 8.3 `handleResponse(payload)` order
1. Ignore when `requestId` is unknown or the request already failed (unchanged).
2. `dispatch(responseReceived(payload))`.
3. `setAgentMode(AGENT_MODE_BY_HEADER[header])` when mapped.
4. UI actions: `routeHeader(payload)` from `src/workspace/headerRoutes.js` (UI-ACTIONS.md §8) →
   `applyUiActions(actions, { source: "header", requestId })`; for `copilot:*` →
   `applyUiActions(data.ui_actions, { source: "copilot", requestId })`. These replace every hardcoded
   `setUserMode`/`setActiveFeature`/`setActiveJobsTab`/`setActiveResumeTool` branch (role-checked now).
5. Terminal failures — when `isEnd` and (header ∈ {`invalid request`, `auth:required`, `error`,
   `AI backend unreachable`, `AI backend timeout`, `AI backend disconnected`, `copilot:error`} or
   `data?.type === "error"`) → `requestFailed({ requestId, message: payload.response || data?.message })` so
   workspaces leave their busy states (Resume "START GENERATOR" no longer stays disabled). `auth:required` also
   dispatches `bootstrapSession()` (refresh or sign-out).
6. `mode:jobparser:addjob:wishlist` with `data.type === "wishlist"`: `toastSuccess(response)` when `data.ok`,
   else `toastError(response)`.
7. `isEnd` → clear the inactivity timer, else re-arm. `RESPONSE_TIMEOUT_MS = 130000` (longer than Node's
   120 s `AI_IDLE_TIMEOUT_MS`, so Node's terminal chunk normally arrives first).

`runFeature(id)`: `AI_FEATURES` entries become `{ id, panel, params?, roles, agentMode, defaultPrompt }`:
`drives → jobs.matched [student]`, `resume-generator → resume.lab {tab:"generator"} [student]`,
`mock-interview → interview [student]`, `job-creation → tpo.job-creator [tpo, admin]`,
`gap-analysis → tpo.gap-analysis [tpo, admin]`. Role not allowed → `toastError("Not available for your role")`
and return `null`; else `applyUiActions([{panel, params}], {source:"user"})`, dedupe running request, send.

### 8.4 Chat UI (`components/Chat.jsx` + helpers in `src/workspace/`)
- Title by mode: `pr_outreach` "PR & OUTREACH ASSISTANT"; feature `mock-interview` "AI INTERVIEW COACH"; teacher
  "TEACHING COPILOT"; tpo "PLACEMENT CELL COPILOT"; else "CAMPUS COPILOT". Header shows a connection dot from
  `useSocketConnected()` (green "LIVE" / red "OFFLINE") next to NEW CHAT.
- Placeholder by role: student "Ask about jobs, attendance, applications or your resume…"; teacher "Schedule a
  class, start attendance, find defaulters…"; tpo/admin "Ask about drives, applicants, offers or stats…";
  `pr_outreach` and interview keep today's text.
- The raw "⚡ header" chip is replaced by `headerLabel(header)` (`src/workspace/headerLabels.js`): `copilot:*`
  "COPILOT", `mode:jobparser:*` "JOB FINDER", `mode:jobCreation:*` "JOB CREATOR", `resume*` "RESUME",
  `mail:review`/`pr_outreach*` "PR OUTREACH", `alumni*` "ALUMNI", interview headers "INTERVIEW",
  `mode:gapAnalysis:*` "GAP ANALYSIS", learning headers "LEARNING", failure headers "ERROR"; `mode:switch:*` and
  `mode:none` render no chip.
- **Tool-call chips** (`ToolCallList` in `src/workspace/ToolCallList.jsx`) under a bot message for each
  `toolCalls[i]`: one row `flex items-center gap-1.5 border border-black px-1.5 py-1 text-[10px] font-bold`:
  `running` → `LoaderCircle animate-spin`, `bg-yellow-100`, label + "…"; `done` → `CircleCheck`, `bg-green-100`,
  label + `summary`; `error` → `CircleX`, `bg-red-100`, label + `error`; `needs_confirmation` → `ShieldQuestion`,
  `bg-blue-100`, label + "awaiting confirmation". Label = `toolLabel(name)` from `src/workspace/toolLabels.js`
  (a map covering every tool in AGENT-TOOLS.md §5, e.g. `attendance_schedule_class` "Schedule class",
  `resume_tailor_for_job` "Tailor resume"; fallback: underscores → spaces, upper-case).
- **Confirmation card**: when the message has `pending`, it is the last bot message and nothing is loading:
  `border-2 border-black bg-yellow-50 p-2` with "CONFIRM ACTION", `pending.preview`, and two buttons
  `btn-primary` "CONFIRM" / `btn-secondary` "CANCEL" that send `"Confirm"` / `"Cancel"` with
  `{ modeName: "copilot", source: "copilot-confirm" }`. For such messages the generic option chips are not
  rendered (no duplicate buttons). Stale cards (message older than 10 min) show "This request expired — ask again."
  with no buttons.
- **Opened-panel chips**: for each distinct `uiActions[i].panel` render `→ OPENED {PANELS[panel].title}`; click
  → `openPanel(panel, params)` (on phones this also switches to the workspace pane).
- Option chips (`message.options`) and the voice-interview input keep today's behaviour.
- NEW CHAT: archives the current chat into history and starts a new persisted session (resets workspaces incl.
  learning, clears `agentMode`, jobs tab → `matched`); both survive reload via the existing persister.

## 9. Notifications UI (shell) — backend contract NOTIFICATIONS.md

### 9.1 Files (`src/features/notifications/`)
`notificationsSlice.js`, `thunks.js`, `push.js`, `NotificationBell.jsx`, `NotificationPanel.jsx`,
`NotificationPreferences.jsx`, `NotificationsBridge.jsx` (mounted once in `AppShell` when authenticated).

### 9.2 Slice `state.notifications`
```js
{ items: Notification[], unread: 0, nextBefore: null, status: "idle"|"loading"|"ready"|"error", error: null,
  preferences: null | { email, push, mutedTypes },
  push: { supported: boolean, serverEnabled: null|boolean, permission: "default"|"granted"|"denied", subscribed: boolean } }
```
Reducers: `notificationsLoaded({items, unread, nextBefore, append})`, `notificationReceived(n)` (prepend, dedupe by
`_id`), `unreadCountChanged(n)`, `notificationMarkedRead(id)`, `allMarkedRead()`, `notificationRemoved(id)`,
`preferencesLoaded(p)`, `pushStateChanged(partial)`, reset on `sessionEnded`.
Thunks: `fetchNotifications({before})`, `fetchUnreadCount()`, `markRead(id)`, `markAllRead()`,
`removeNotification(id)`, `loadPreferences()`, `savePreferences(p)`, `enablePush()`, `disablePush()`.

### 9.3 Bell, panel, toasts
- `NotificationBell` (no props): `Bell` icon button (`aria-label="Notifications"`) with a black unread count badge
  (99+); click → `openPanel("notifications")`.
- `NotificationPanel` (overlay; `usePanel("notifications")` → `params.tab`): desktop = popover anchored under the
  header right (`w-[380px] max-h-[70vh]`); phone = full-screen sheet. Tabs INBOX / PREFERENCES. Inbox: first
  open → `fetchNotifications()`; rows show priority bar, title, body (2 lines), relative time, unread dot, delete
  (×); "LOAD MORE" while `nextBefore`; "MARK ALL READ". Row click → `markRead(id)` (if unread), close overlay,
  `applyUiActions([n.ui], {source:"notification"})` when `n.ui`.
- `NotificationsBridge`: `useSocketEvent("notification:new", ({notification}) => …)` → `notificationReceived`;
  `useSocketEvent("notification:count", ({unread}) => unreadCountChanged(unread))`; `useOnSocketConnect(() =>
  fetchUnreadCount())`. Toast rule: skip when `notification.type` starts with a muted prefix; `priority:"high"` →
  toast always (8 s); `normal` → toast only when `document.visibilityState === "visible"` (5 s); `low` → no
  toast. Toast = title (bold, upper-case), body, and an "OPEN" button when `ui` (applies it, marks read).
- Also listens to `navigator.serviceWorker` `message` events `{type:"open-url", url}` → `parsePanelUrl` →
  apply (`source:"deeplink"`) and mark `nid` read.

### 9.4 Web push (opt-in)
- Supported when `"serviceWorker" in navigator && "PushManager" in window && window.isSecureContext`.
- `enablePush()` (must run from a click): `getPushPublicKey()` → `{enabled, publicKey}` (not enabled → message
  "Push is not configured on the server"); `Notification.requestPermission()`; register `/sw.js` (scope `/`);
  `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) })`;
  `subscribePush(subscription.toJSON())`; `pushStateChanged({subscribed:true})`.
- `disablePush()`: current subscription → `unsubscribePush(endpoint)` → `subscription.unsubscribe()`. Called
  by the PREFERENCES toggle and by `logout()` (a shared phone must stop receiving the previous user's alerts).
- Prompt: the inbox shows a one-line card "GET ALERTS ON THIS DEVICE — ENABLE" when supported, server-enabled,
  `permission === "default"` and not subscribed. Unsupported iOS Safari → hint "Add this app to your Home Screen
  to receive alerts."
- `public/sw.js` (plain JS, no imports): `install` → `skipWaiting()`; `activate` → `clients.claim()`; `push` →
  parse JSON `{title, body, url, tag, notificationId, priority}` (text fallback) → `showNotification(title ||
  "Matchy Campus", { body, tag: tag || notificationId, data: { url, notificationId }, icon: "/favicon.svg",
  badge: "/favicon.svg" })`; `notificationclick` → close; resolve `url` against `self.location.origin` and
  **ignore any other origin** (fallback `/`); focus an existing same-origin window and `postMessage({type:
  "open-url", url})`, else `clients.openWindow(url)`.

### 9.5 Preferences tab (`NotificationPreferences.jsx`)
`loadPreferences()`; toggles "EMAIL ME" (`email`), "PUSH TO MY DEVICES" (`push`), "THIS DEVICE"
(enable/disable push); muted categories checkboxes for prefixes `attendance.`, `placement.`, `training.`,
`jobfeed.`, `system` → `savePreferences({email, push, mutedTypes})`.

### 9.6 Help / issue reports (`src/features/help/`)
`ReportIssueForm({ defaultName, defaultEmail, defaultDescription, pageUrl, onDone })` — name, email,
description (required, ≤ 2000) → `submitIssueReport({ name, email, description, pageUrl })` → shows the server
`message`. Used by `ReportIssuePage` (public route) and `ReportIssueModal` (overlay `report-issue`, prefilled from
the user and `params.description`, `pageUrl = location.href`).

### 9.7 SidebarDrawer (shell) `({ isOpen, onClose, user, onLogout, chatSessions, onSelectChat })`
Keep chat history. Account box badge by role (STUDENT / FACULTY / TPO / ADMIN / RECRUITER / ALUMNI ACCOUNT), no
"Alex Rivera" fallbacks; "EDIT PROFILE" → `openPanel("profile")`. Replace the two fake toggles with buttons:
"NOTIFICATIONS" → `openPanel("notifications")`, "NOTIFICATION SETTINGS" → `openPanel("notifications",
{tab:"preferences"})`, students: "AI KEYS (BYOK)" → `openPanel("settings.ai-keys")`, everyone: "REPORT AN
ISSUE" → `openPanel("report-issue")`. LOGOUT → `dispatch(logout())`.

## 10. Layout, overlays, mobile (shell)

```
<div className="flex h-dvh flex-col overflow-hidden bg-[#f8fafc] text-black">
  <HeaderBar/>
  <main className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col px-3 py-3 sm:px-4 sm:py-4">
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-12 lg:gap-6">
      <section className={`${pane==="chat" ? "flex" : "hidden"} min-h-0 flex-col lg:col-span-4 lg:flex`}><Chat/></section>
      <section className={`${pane==="workspace" ? "block" : "hidden"} min-h-0 lg:col-span-8 lg:block ${fullHeight ? "overflow-hidden" : "overflow-y-auto pr-1"}`}>
        <ErrorBoundary resetKey={activePanel}><Suspense fallback={<LoadingState/>}><WorkspaceView/></Suspense></ErrorBoundary>
      </section>
    </div>
  </main>
  <MobilePaneSwitcher/>   {/* lg:hidden; fixed bottom bar CHAT | WORKSPACE; dot when workspaceAttention */}
  <OverlayHost/> <SidebarDrawer …/>
</div>
```
- `fullHeight` = `activeMode === "resume"` and `activeResumeTool ∈ {generator, editor, tailor}` (registry flag).
- `WorkspaceView` (`src/workspace/WorkspaceView.jsx`) = today's `renderActiveMode()` (welcome → AccessDenied
  guard → mode page) moved out of App.jsx.
- `OverlayHost` renders `NotificationPanel` / `ProfileModal` / `ReportIssueModal` from `appContext.overlay`;
  Esc and backdrop click → `overlayClosed()`.
- `ErrorBoundary` keeps one crashing panel from blanking the app (fallback: `ErrorState` with "RELOAD PANEL").
- App.jsx no longer fetches dashboard data (`fetchStudentDashboardData`, `resumeScoreData`, `databaseJobs`,
  `aiMatchedJobs` are removed; each feature loads its own data).

## 11. Component contracts

### 11.1 Components the shell imports (owners MUST provide exactly these)
| Path (`src/…`) | Export | Props | Owner | Rendered by |
|---|---|---|---|---|
| `pages/TeacherMode.jsx` | default `TeacherMode` | `{ user }` | attendance-teacher | WorkspaceView (mode `teacher`) |
| `features/attendance/teacher/PresenterPage.jsx` | default `PresenterPage` | none (`useParams().sessionId`) | attendance-teacher | route `/present/:sessionId` |
| `features/attendance/teacher/AttendanceOversightPanel.jsx` | default `AttendanceOversightPanel` | none (`usePanel("tpo.attendance")`) | attendance-teacher | AdminMode `attendance-oversight` |
| `features/attendance/student/AttendPage.jsx` | default `AttendPage` | none (`useSearchParams`) | attendance-student | route `/attend` |
| `features/attendance/student/StudentAttendancePanel.jsx` | default `StudentAttendancePanel` | none (`usePanel("attendance.student")`) | attendance-student | StudentMode `attendance` |
| `features/attendance/student/ScanPanel.jsx` | default `ScanPanel` | none | attendance-student | StudentMode `attendance-scan` |
| `features/attendance/student/StudentSchedulePanel.jsx` | default `StudentSchedulePanel` | none (`usePanel("schedule")`) | attendance-student | StudentMode `schedule` |
| `features/attendance/student/summary.js` | named `useAttendanceSummary()` → `{ overallPercent: number\|null, status: "safe"\|"warning"\|"critical"\|"no-data", nextClass: Session\|null, loading, error }` | – | attendance-student | StudentMode tiles |
| `features/opportunities/JobsHub.jsx` | default `JobsHub` | none (reads `activeJobsTab` + `usePanel`) | opportunities | StudentMode `drives` |
| `features/opportunities/ApplicationsPanel.jsx` | default `ApplicationsPanel` | none (`usePanel("applications")`) | opportunities | StudentMode `applications` |
| `features/opportunities/CalendarPanel.jsx` | default `CalendarPanel` | none (`usePanel("calendar")`) | opportunities | StudentMode `calendar` |
| `components/StudentOffers.jsx` | default `StudentOffers` | none (`usePanel("offers")`) | opportunities | StudentMode `offers` |
| `components/TrainingHub.jsx` | default `TrainingHub` | none (`usePanel("training")`) | opportunities | StudentMode `training` |
| `features/opportunities/summary.js` | named `useOpportunitySummary()` → `{ campusCount, aiMatches, applicationsActive, offersPending, trainingUpcoming, loading, error }` (numbers, 0 when unknown) | – | opportunities | StudentMode tiles |
| `features/opportunities/jobVM.js` | named `toJobVM(raw, origin)`, `toAgentJob(vm)` (§13.3) | – | opportunities | InterviewWorkspace (shell) |
| `pages/ResumeStudio.jsx` | default `ResumeStudio` | `{ user }` | resume | WorkspaceView (mode `resume`) |
| `pages/CompanyMode.jsx` | default `CompanyMode` | `{ user }` | tpo | WorkspaceView (mode `company`) |
| `features/tpo/DrivesPanel.jsx` | default `DrivesPanel` | `{ scope: "tpo" \| "company" }` | tpo | AdminMode `job-postings` (scope tpo); CompanyMode |
| `features/tpo/ApplicantsPanel.jsx` | default `ApplicantsPanel` | `{ scope }` | tpo | AdminMode `application-review`; CompanyMode |
| `features/tpo/PlacementAnalyticsPanel.jsx` | default `PlacementAnalyticsPanel` | none | tpo | AdminMode `placement-analytics` |
| `features/tpo/TpoCalendarPanel.jsx` | default `TpoCalendarPanel` | none | tpo | AdminMode `placement-calendar` |
| `features/tpo/JobFeedAdminPanel.jsx` | default `JobFeedAdminPanel` | none | tpo | AdminMode `job-feed` |
| `features/tpo/FacultyPanel.jsx` | default `FacultyPanel` | none | tpo | AdminMode `faculty` |
| `features/tpo/IssueReportsPanel.jsx` | default `IssueReportsPanel` | none | tpo | AdminMode `issue-reports` |
| `components/OfferManagement.jsx` | default `OfferManagement` | none | tpo | AdminMode `offer-management` |
| `components/PolicyConfigPanel.jsx` | default `PolicyConfigPanel` | none | tpo | AdminMode `policy-configuration` |
| `components/TrainingScheduler.jsx` | default `TrainingScheduler` | none | tpo | AdminMode `training-scheduler` |
| `components/GapAnalysisPanel.jsx` | default `GapAnalysisPanel` | none | tpo | AdminMode `gap-analysis` |

All panel components read their params with `usePanel(<their panel id>)` (DrivesPanel/ApplicantsPanel use
`scope === "company" ? "company.drives" : "tpo.drives"` etc.) and render a complete card (own header) — the mode
page only adds the back bar.

### 11.2 Shell exports others import (read-only)
| Path | Exports |
|---|---|
| `src/workspace/index.js` | `openPanel`, `switchMode`, `applyUiActions`, `usePanel`, `useActivePanel`, `PANELS`, `PANELS_BY_ROLE`, `MODE_DEFS`, `ROLE_MODES`, `allowedModesFor`, `buildPanelUrl`, `parsePanelUrl` |
| `src/features/auth/RequireAuth.jsx` | default `RequireAuth({ roles?, title?, subtitle?, children })` |
| `src/features/auth/useSession.js` | `useSession()` |
| `src/ui/index.js` | everything in §11.3 |
| `src/lib/config.js` | `API_ORIGIN`, `API_BASE`, `APP_NAME`, `GOOGLE_CLIENT_ID`, `IS_SECURE_CONTEXT()` |
| `src/lib/storage.js` | `getItem`, `setItem`, `removeItem`, `getJSON`, `setJSON` (localStorage); `session` variants `sessionGet`, `sessionSet`, `sessionRemove` |
| `src/lib/http.js`, `src/lib/realtime.js`, `src/lib/socket.js` | as in §0 |
| `src/services/aiRequestHandler.js` | `sendAIMessage`, `runAIFeature` |
| `src/store/appContextSlice.js`, `src/store/aiChatSlice.js` | selectors/actions listed in §7 |
| `src/lib/api/placements.js` (opportunities) | read-only for shell (InterviewWorkspace), resume (job pickers), tpo |
| `src/lib/api/jobFeed.js` (opportunities) | read-only for resume (job pickers) and tpo (feed browser) |
| `src/lib/api/resumes.js` (resume) | `listResumes` read-only for opportunities (apply dialog resume picker) |
| `src/components/PlacementCalendar.jsx` (opportunities) | read-only for tpo (`TpoCalendarPanel`) — props in §13.3 |

### 11.3 Shared UI kit `src/ui/` (shell)
| File | Export | Props / signature |
|---|---|---|
| `Panel.jsx` | default `Panel` | `{ title, icon: Icon?, badge?, actions?, children, className? }` → `card-stark` + header recipe (§15.4) |
| `EmptyState.jsx` | default `EmptyState` | `{ icon?, title, text?, action? }` dashed box |
| `LoadingState.jsx` | default `LoadingState` | `{ label = "LOADING…" }` |
| `ErrorState.jsx` | default `ErrorState` | `{ error, title = "SOMETHING WENT WRONG", onRetry? }` (`errorMessage(error)`) |
| `StatusBadge.jsx` | default `StatusBadge` | `{ status, kind, children? }` → `badge-stark` + `STATUS_COLORS[kind][status]` |
| `statusColors.js` | `STATUS_COLORS` | §15.5 |
| `Tabs.jsx` | default `Tabs` | `{ tabs: [{id, label, count?}], value, onChange, className? }` segmented, scrolls horizontally on phones |
| `Modal.jsx` | default `Modal` | `{ open, title, onClose, children, footer?, size: "sm"\|"md"\|"lg" }`; full-screen < sm; Esc closes; `role="dialog" aria-modal` |
| `ConfirmDialog.jsx` | default `ConfirmDialog` | `{ open, title, body?, confirmLabel = "CONFIRM", cancelLabel = "CANCEL", danger?, busy?, requireReason?, reasonLabel?, onConfirm(reason), onCancel }` |
| `ErrorBoundary.jsx` | default `ErrorBoundary` | `{ resetKey?, fallback?, children }` (class component) |
| `Field.jsx` | default `Field` | `{ label, hint?, error?, children }` |
| `toast.js` | `toastSuccess(msg)`, `toastError(errorOrMsg, fallback?)`, `toastInfo(msg)`, `STARK_TOAST_STYLE` | react-hot-toast with stark style (`borderRadius:0, border:"2px solid #000", boxShadow:"4px 4px 0 0 #000", fontWeight:700, fontSize:12`) |
| `format.js` | `formatDate`, `formatTime`, `formatDateTime`, `formatRelative`, `formatPercent`, `formatLpa` | `en-IN`, browser time zone |
| `useAsync.js` | `useAsync(load, deps, { enabled = true })` → `{ data, error, loading, reload, setData }` | runs `load()` when `deps` change; ignores stale results; `loading` derived (no synchronous setState in the effect) |
| `index.js` | barrel of all of the above | |

## 12. Mode pages

### 12.1 StudentMode (shell) `({ user })`
Header card "WELCOME BACK, {name}" + branch/CGPA/email (no "Alex Rivera"/"0.0"/fake email fallbacks — show
"Not set") + "EDIT PROFILE" (`openPanel("profile")`). Home tiles (FeatureCard recipe), order on phones puts SCAN
QR and MY ATTENDANCE first:

| Tile | Icon | Badge | Opens |
|---|---|---|---|
| SCAN ATTENDANCE QR | `ScanQrCode` | "MARK PRESENT" | `attendance.scan` |
| MY ATTENDANCE | `CalendarCheck` | `{overallPercent}%` colored by status, "NO CLASSES YET" when null | `attendance.student` |
| CLASS SCHEDULE | `CalendarClock` | next class `formatTime` or "NO UPCOMING CLASS" | `schedule` |
| CAMPUS DRIVES | `Building2` | `{campusCount} OPEN` | `jobs.campus` |
| AI JOB MATCHES | `Sparkles` | `{aiMatches} MATCHES` | `jobs.matched` |
| OPEN MARKET JOBS | `Globe` | "LIVE FEED" | `jobs.market` |
| MY APPLICATIONS | `ClipboardList` | `{applicationsActive} ACTIVE` | `applications` |
| MY OFFERS | `Package` | `{offersPending} PENDING` | `offers` |
| TRAINING | `BookOpen` | `{trainingUpcoming} UPCOMING` | `training` |
| PLACEMENT CALENDAR | `CalendarDays` | "DRIVES & DEADLINES" | `calendar` |
| MY PORTFOLIO | `User` | "PROFILE" | `portfolio` |
| MOCK INTERVIEW | `Mic2` | "AI INTERVIEWER" | `interview` + `runAIFeature("mock-interview")` when the interview workspace is `idle`/`error` |
| LEARNING ROADMAP | `GraduationCap` | "AI RECOMMENDER" | `learning` |
| ALUMNI CONNECT | `Users` | "MENTORS" | `alumni` |

Feature view: back bar "← STUDENT HOME" (`openPanel("student.home")`) + title from the registry, then:
`drives → <JobsHub/>`, `applications → <ApplicationsPanel/>`, `offers → <StudentOffers/>`, `training →
<TrainingHub/>`, `calendar → <CalendarPanel/>`, `attendance → <StudentAttendancePanel/>`, `attendance-scan →
<ScanPanel/>`, `schedule → <StudentSchedulePanel/>`, `mock-interview → <InterviewWorkspace/>`,
`learning-recommendation → <LearningRecommendationWorkspace/>`, `portfolio` → today's inline view (tab from
`usePanel("portfolio").params.tab`). The inline always-empty applications table is deleted.

### 12.2 AdminMode (shell) — TPO tool grid
Tiles (title → panel): AI JOB CREATOR → `tpo.job-creator` (+ `runAIFeature("job-creation")` when no draft), GAP
ANALYSIS → `tpo.gap-analysis` (+ `runAIFeature("gap-analysis")` when idle), PLACEMENT DRIVES → `tpo.drives`,
APPLICANTS → `tpo.applicants`, OFFER MANAGEMENT → `tpo.offers`, PLACEMENT POLICY → `tpo.policy`, PLACEMENT
ANALYTICS → `tpo.analytics`, TRAINING SCHEDULER → `tpo.training`, DRIVE CALENDAR → `tpo.calendar`, JOB FEED →
`tpo.job-feed`, FACULTY → `tpo.faculty`, ATTENDANCE OVERSIGHT → `tpo.attendance`, ISSUE REPORTS → `tpo.issues`.
The three "COMING SOON" tiles and the inline `JobPostingsPanel`/`normalizeDrive`/`api.getJobs` are removed.
`JobCreatorPanel` stays inline and gains "NEW JOB" (`startNewAIChat(name)` then `runAIFeature("job-creation")`
— a new chat session means a new draft, fixing TPO-1 "second job overwrites the first" from the frontend side).

### 12.3 TeacherMode (attendance-teacher) `({ user })`
Header card (name, department/designation), a TODAY strip (`listSessions({from: startOfToday, to: endOfToday})`)
with per-session START / PRESENT / REPORT buttons, tiles MY COURSES (`teacher.courses`), CLASS SCHEDULE
(`teacher.schedule`), LIVE ATTENDANCE (`teacher.live`), SESSION REPORTS (`teacher.report`), COURSE ANALYTICS
(`teacher.analytics`); feature view = back bar "← TEACHER HOME" + the panel for `activeFeature` (§13.1).

### 12.4 CompanyMode (tpo) `({ user })`
Header with `user.company?.name || user.name` and `user.email` (no fake "VERIFIED RECRUITER", no
`recruiter@company.com`); tiles MY DRIVES (`company.drives`), POST A DRIVE (`company.drives {create:true}`),
APPLICANTS (`company.applicants`); feature view renders `DrivesPanel scope="company"` / `ApplicantsPanel
scope="company"`. The broken `api.createDrive` form and its hardcoded defaults are deleted.

### 12.5 ResumeStudio (resume) `({ user })`
Reads `activeResumeTool` and `usePanel("resume.lab")`; home grid of tools CATALOG, EDITOR, AI TAILOR, ATS
SCORE, GENERATOR, SKILL GAP, AI KEYS (`openPanel("resume.lab", {tab})`, AI KEYS → `openPanel("settings.ai-keys")`;
GENERATOR also `dispatch(runAIFeature("resume-generator"))`). Back bar → `openPanel("resume.home")`. The header
card must not combine `card-stark bg-black` with black text (it becomes visible after the CSS fix, §15.2).

## 13. Feature specifications per owner

### 13.1 attendance-teacher (backend: ATTENDANCE.md)
Files: `pages/TeacherMode.jsx`, `features/attendance/teacher/{CoursesPanel, SchedulePanel, LiveSessionPanel,
SessionReportPanel, CourseAnalyticsPanel, AttendanceOversightPanel, PresenterPage, QrDisplay}.jsx`,
`features/attendance/teacher/{useLiveSession, courseForm}.js`, `lib/api/attendance.js`.
- **CoursesPanel** (`teacher.courses`): list `listCourses()` (code, name, section, studentCount, next session);
  CREATE COURSE (`params.create`) form: code, name, branch, semester, section, passingYear, academicYear, room,
  timetable rows `{day 0–6, start "HH:mm", durationMinutes 15–300, room}`, settings (minAttendancePercent,
  qrRotationSeconds 5–120, lateAfterMinutes, requireGeo, geoRadiusMeters, autoEndGraceMinutes, autoGenerateDays),
  "auto-enroll matching students" → `createCourse`. Detail (`params.courseId`, tabs overview/students/
  timetable/settings): join code with COPY + REGENERATE; students table (roll/enrollment, name, %, status
  badge) with ADD BY EMAILS (textarea → `addStudents` → shows `notFound`), AUTO-ENROLL, REMOVE (confirm);
  timetable edit + GENERATE SESSIONS (`generateSessions`); settings edit (`updateCourse`); ARCHIVE (confirm).
- **SchedulePanel** (`teacher.schedule`): sessions `listSessions({from, to, courseId})` as a day-grouped list
  (phones) or week grid (≥ lg, `params.view`); status badges incl. `isMissed`. NEW CLASS: course, date+time
  (`datetime-local` → ISO) or free text `when` ("tomorrow 10am"), duration, room, topic, mode → `createSession`;
  FIND A FREE SLOT → `autoScheduleSession` (shows `reason`); RESCHEDULE (`updateSession`, scheduled only); CANCEL
  (ConfirmDialog with reason → `cancelSession`); START → `openPanel("teacher.live", {sessionId})`. `409
  SCHEDULE_CONFLICT` lists `details.conflicts` (course, time). Refresh on `attendance:session`.
- **LiveSessionPanel** (`teacher.live`): no `sessionId` → live + today's sessions picker. Scheduled → START
  (captures geolocation first when `course.settings.requireGeo`) → `startSession(id, {geo})`. Live →
  `useLiveSession(sessionId)`: joins with `joinPresenter` (ack `{ok, qr, stats}`), listens `attendance:qr`,
  `attendance:marked`, `attendance:session`, re-joins `useOnSocketConnect`, leaves on unmount, polls
  `getSessionQr` every `max(2, rotationSeconds/3)` s while `!useSocketConnected()`. Shows `QrDisplay` (QR of
  `qr.url` + countdown bar to `expiresAt`), present/late/enrolled counters, live roster (newest marks on top,
  `flags` as badges), manual mark per student (present/late/absent/excused + note → `markRecord`), END SESSION
  (confirm → `endSession` → `openPanel("teacher.report", {sessionId})`), PRESENT FULL SCREEN
  (`window.open("/present/" + id, "_blank", "noopener")`).
- **SessionReportPanel** (`teacher.report`): `getSession(sessionId)` roster with status, method, marked time,
  flags; manual overrides; EXPORT CSV (`downloadSessionCsv` → save as `attendance-<code>-<date>.csv`). Without
  `sessionId`: recent ended sessions to pick from (`listSessions({status:"ended"})`).
- **CourseAnalyticsPanel** (`teacher.analytics`): course picker; `getCourseReport(courseId)`: held count, per-
  student attended/late/absent/excused/percent/status/needToReach, sortable; threshold slider (`params.threshold`
  default course setting) highlights defaulters; NOTIFY DEFAULTERS (confirm + optional message →
  `notifyDefaulters` → toast "Notified n students").
- **AttendanceOversightPanel** (`tpo.attendance`, read-only): all courses (`listCourses()`), course report, session
  report; no mutations.
- **PresenterPage** (`/present/:sessionId`, mobile-first): `h-dvh` white page, QR square = `min(92vw, 100dvh −
  header − footer)`, rendered with `QRCode.toCanvas(canvas, qr.url, { errorCorrectionLevel: "M", margin: 2,
  width })` on every new token; header (course code + name, topic, LIVE badge, present/enrolled); countdown bar;
  footer with the last 5 names marked, END SESSION (confirm), EXIT. Requests a screen wake lock
  (`navigator.wakeLock?.request("screen")`, re-acquired on `visibilitychange`) and offers FULL SCREEN. Not live →
  "THIS SESSION IS NOT LIVE" + START (owner, scheduled) or back link; ended (`attendance:session`) → final
  counts. Works in portrait and landscape; no horizontal scroll at 360 px.
- `useLiveSession`, `QrDisplay` are shared by LiveSessionPanel and PresenterPage (same owner).

### 13.2 attendance-student (backend: ATTENDANCE.md; API: `lib/api/attendance.js` read-only)
Files: `features/attendance/student/{StudentAttendancePanel, ScanPanel, StudentSchedulePanel, AttendPage,
QrScanner, ScanResult}.jsx`, `features/attendance/student/{scan, summary}.js`.
- **scan.js** (pure, node-tested): `parseAttendUrl(text)` → `{ sessionId, token } | null` — accepts an absolute
  URL or a path whose pathname ends with `/attend` and has non-empty `s` and `t` (other params ignored; any
  origin accepted because only `s`/`t` are used and the app never navigates to scanned URLs); `getDeviceId()`
  — `localStorage["attendance:device-id"]`, created once with `crypto.randomUUID()`; `createScanController({
  submit, now })` — retry policy below.
- **Submit**: `submitScan({ sessionId, token, deviceId, geo })`. First attempt without `geo` unless geolocation
  permission is already `granted` (then fetch a position with a 3 s timeout and include it). `400
  LOCATION_REQUIRED` → request `getCurrentPosition({enableHighAccuracy:true, timeout:10000})` and retry once
  immediately (the token was not consumed); geolocation needs HTTPS — insecure origin → message "Location
  needs a secure (https) connection." `403 OUT_OF_RANGE` → message + "SCAN AGAIN".
- **Outcome messages** come from `attendanceErrorMessage(error)` (§14.4). Terminal: `ALREADY_MARKED` (shown as
  success-like info), `NOT_ENROLLED` (+ JOIN A COURSE button → `attendance.student`), `DEVICE_ALREADY_USED`,
  `SESSION_NOT_LIVE`, `INVALID_TOKEN`. Retryable: `TOKEN_EXPIRED`, `OUT_OF_RANGE`. `TOO_MANY_ATTEMPTS` → pause 60 s.
- **QrScanner** `({ onToken, paused })`: `getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio:
  false })`; decode with `BarcodeDetector` when `getSupportedFormats()` includes `qr_code`, else `jsQR` on a
  canvas downscaled to ≤ 640 px wide (`import("jsqr")` lazily), every ~150 ms; stops all tracks on unmount;
  `NotAllowedError` → instructions to allow the camera; insecure origin → "The in-app scanner needs https. Use
  your phone's camera app to scan the QR instead."
- **Retry policy** (classroom rush; tokens are single-use and rotate): keep the camera running after
  `TOKEN_EXPIRED` and show "QR CHANGED — KEEP POINTING AT THE SCREEN"; ignore a token value already tried; at
  most 1 submit per 2 s and 6 submits per rolling minute (backend limit is 10/min), then pause with a message;
  stop on success or a terminal code. Success → `navigator.vibrate?.(80)` and the result card.
- **ScanResult**: status (PRESENT / LATE badge), course code + name, topic, marked time, updated summary
  `attended/held (percent%)`; buttons OPEN MY ATTENDANCE, DONE.
- **ScanPanel** (`attendance.scan`): QrScanner + result; listens `attendance:confirmed` to confirm a scan whose
  HTTP response was lost (no toast otherwise).
- **AttendPage** (`/attend`): §5 flow; minimal standalone header (`APP_NAME` + "OPEN APP" link); no `s`/`t` →
  scanner directly; non-student signed in → RequireAuth role card.
- **StudentAttendancePanel** (`attendance.student`): `getMySummary()` → overall card + per-course cards (code,
  name, `attended/held`, percent, status badge, copy "Attend the next {needToReach} classes to reach {min}%" or
  "You can miss {canSkip} classes and stay above {min}%"); course detail (`params.courseId`) with history
  `getMyHistory({courseId})`; JOIN A COURSE (6-char code, upper-cased → `joinCourse` → toast + refresh); SCAN QR
  button → `attendance.scan`.
- **StudentSchedulePanel** (`schedule`): `getMySchedule({days: params.days ?? 7})` grouped by day; live sessions
  highlighted with SCAN NOW (`attendance.scan`); cancelled struck through with reason; `myRecord` badge;
  refetch on `attendance:session`.
- **summary.js** `useAttendanceSummary()`: one `getMySummary()` + `getMySchedule({days:2})`, cached in module
  memory for 60 s; never throws.

### 13.3 opportunities (backend: PLACEMENTS.md, JOB-FEED.md)
Files: `features/opportunities/{JobsHub, MatchedJobsTab, CampusJobsTab, MarketJobsTab, TrackerTab, JobDetail,
ApplyDialog, ApplicationsPanel, CalendarPanel}.jsx`, `features/opportunities/{jobVM, summary}.js`, the five
components, `lib/api/placements.js`, `lib/api/jobFeed.js`.
- **jobVM.js** (pure, node-tested):
  ```
  toJobVM(raw, origin /* "campus" | "market" | "ai" */) → {
    id, kind: "campus"|"external", source: "campus"|"market", origin, sourceLabels: string[],
    companyName, companyLogo, roleTitle, location, salaryText, packageLpa /* number|null, parsed from "12 LPA"/ctc */,
    jdText, skillsRequired: string[], applicationUrl, deadline, driveDate, postedAt, jobType, workType, experience,
    minCgpa, eligibleBranches: string[], maxBacklogs, graduationYears: string[],
    isEligible /* true|false|null (null = not evaluated) */, eligibilityReasons: string[],
    matchScore /* 0–100|null */, matchedSkills: string[], applicationStatus /* string|null */, saved /* market tracker status|null */,
    saveable, isSample, isNew, categories: string[], raw }
  ```
  Campus raw = PLACEMENTS job (`id|_id, title, company ({name}|string), location, salary|ctc|packageLpa,
  employmentType, skills, description, applicationDeadline, driveDate, minimumCgpa, maximumBacklogs,
  eligibleBranches, graduationYears, isEligible, eligibilityReasons, matchScore, matchedSkills, myApplication,
  applicationUrl, createdAt`); market raw = `PublicExternalJob` (JOB-FEED.md §7.1); ai raw = `JobsListItem`
  (JOB-FEED.md §12.5: `kind` decides `source`). Never produces `undefined` for list fields; "Not mentioned"
  strings become `null`. `toAgentJob(vm)` → `{ _id: vm.id, id: vm.id, title, job_title, company_name, company,
  description, skills, location, salary, employment_type, application_url, kind }` for `journey.selectedJob` and
  `details.selected_job`.
- **JobsHub** (`jobs.*`): tabs AI MATCHES | CAMPUS | OPEN MARKET | SAVED (each `openPanel("jobs.<tab>")`, keeping
  params) and the detail view for tab `detail`.
  - AI MATCHES: `selectLatestJobs` → `toJobVM(item, "ai")`; badges CAMPUS / OPEN MARKET / SAMPLE; FIT badge only
    when `matchScore !== null`; eligibility badge only for campus; empty → "FIND MATCHES WITH AI" →
    `dispatch(runAIFeature("drives"))`.
  - CAMPUS: `listCampusJobs(params)`; search + location + "ELIGIBLE ONLY"; ineligible cards show the first reason
    and a disabled apply; APPLY → `ApplyDialog` (resume from `listResumes()` (resume-owned module) optional,
    cover note ≤ 1000) → `applyToJob` → toast, card shows status; external `applicationUrl` → APPLY NOW link.
  - OPEN MARKET: `listMarketJobs({...params, limit: 10})`, filters q / jobType / workType / location / category
    (`listMarketCategories`) / source (`listMarketSources`) / sort newest|match, pagination; card: "via <source
    labels>", categories, logo, NEW / SAMPLE badges, APPLY (external), SAVE / MARK APPLIED (`saveMarketJob(id,
    {status})`), TAILOR RESUME (`openPanel("resume.lab", {tab:"tailor", jobId, jobSource:"market"})`), DETAILS;
    `params.highlightIds` cards outlined; refresh hint on socket `job-feed:updated`.
  - SAVED: `listSavedJobs({status})` with status tabs (saved, applied, interviewing, offer, rejected) and counts;
    change status, notes, remove (confirm); `jobAvailable:false` → snapshot + "no longer in the feed".
  - DETAIL (`params.jobId`, `params.source`): `getCampusJob` / `getMarketJob`; full description, facts,
    eligibility, actions as above, PRACTICE INTERVIEW (`journeyJobSelected(toAgentJob(vm))`,
    `openPanel("interview")`, `runAIFeature("mock-interview")`), back → `params.from` tab or by source.
- **ApplicationsPanel** (`applications`): `listMyApplications({status})`; card/table with company, role, status
  badge, timeline; WITHDRAW (confirm) when allowed; `params.applicationId` highlighted and scrolled into view.
- **StudentOffers** (rewrite, `offers`): `listMyOffers()`; ACCEPT / UPGRADE & ACCEPT / REJECT (ConfirmDialog with
  reason) / WITHDRAW ACCEPTANCE (ConfirmDialog with reason); one-offer policy banner; fix the "{packageLpa}x vs
  current" copy to "{packageLpa} LPA vs current {currentAcceptedPackage} LPA"; guards for missing
  `statusHistory`/status (no crash); `params.offerId` highlighted.
- **TrainingHub** (rewrite, `training`): tabs DISCOVER / MY PROGRAMS (`params.tab`); `listTrainingPrograms()`,
  `listMyTraining()`, ENROLL (`registerForTraining`); guards for empty `schedule`, missing `status`,
  `capacity` 0; attendance shown as `attendance.length/schedule.length` only when both exist; CERTIFICATE only when
  `certificateUrl` (opens it); `params.programId` highlighted. Fix the `react-hooks/immutability` error.
- **CalendarPanel** (`calendar`): events = `getPlacementCalendar({from, to})` when available, else composed from
  campus jobs (`driveDate` "Drive", `deadline` "Deadline"), my training sessions and pending offer `expiresAt`;
  renders `PlacementCalendar`.
- **PlacementCalendar** props (stable, also used by tpo): `{ drives = [], events?: [{ id, date, title, subtitle?,
  kind?: "drive"|"deadline"|"training"|"offer"|"class", location? }], title = "PLACEMENT CALENDAR", compact = false,
  initialDate? }`; legacy `drives` items (driveDate|eventDate|date|deadline + companyName/roleTitle) still work;
  the visible month follows the first dated item when data arrives after mount (fix "computed once").
- **DriveGrid / DriveCard**: may be reused by the tabs with the JobVM; DriveCard renders no FIT badge when
  `matchScore` is null, "Not disclosed" instead of "12 LPA", no "Remote" fallback, "MIN CGPA" only when set, no
  `api.applyToDrive`, no `alert`.
- **summary.js** `useOpportunitySummary()`: `listCampusJobs({limit:1})` total, `latestJobs.length`,
  `listMyApplications()` active count (status not in rejected/withdrawn), `listMyOffers()` pending
  (`extended`), `listMyTraining()` upcoming; cached 60 s; never throws.

### 13.4 resume (backend: RESUME-BYOK.md)
Files: `pages/ResumeStudio.jsx`, `features/resume/{CatalogPanel, EditorPanel, TailorPanel, AtsPanel, SkillGapPanel,
AiKeysPanel, ResumePicker, PatchReviewList}.jsx`, `features/resume/patches.js`, the two components,
`lib/api/resumes.js`, `lib/api/llm.js`. Port logic (not styling) from Matchy
`personal_project/frontend/src/pages/{resume-catalog-page,resume-editor-page,configure-keys-page}.jsx` and
`components/resume-picker.jsx`.
- **CatalogPanel** (`resume.lab` tab catalog): list `listResumes()` (name, ACTIVE badge, size, dates); NEW from
  `.tex` file or pasted LaTeX → `createResume`; OPEN → `resume.lab {tab:"editor", resumeId}`; SET ACTIVE
  (`activateResume`), DUPLICATE, DELETE (ConfirmDialog); a second section "GENERATED PDFs (RESUME BANK)" lists
  the legacy bank (`listBankResumes`) with VIEW PDF (`getBankResumeUrl` → new tab) — alumni sharing depends on it.
- **EditorPanel** (`editor`, full-height): `getResume(resumeId)`; monospace textarea with line numbers; COMPILE
  (`compileLatex`, debounced 1.5 s after typing stops, or on demand) → PDF `<iframe>` from an object URL (revoke
  the old one); SAVE (`updateResume`), RENAME, DOWNLOAD .TEX / .PDF; unsaved-changes guard (`beforeunload` and a
  ConfirmDialog when switching panels/resumes); compile errors show the server log text.
- **TailorPanel** (`tailor`, full-height): resume picker, job picker (campus via `listCampusJobs`, market via
  `listMarketJobs`; preselected from `params.jobId`/`params.jobSource`), credential picker (`listLlmProviders()`
  credentials; none → link to `settings.ai-keys`). RUN → `tailorResume(...)`; `requiresManualJD` → JD textarea
  **kept per job id** (fixes Matchy's JD leak across jobs). Patches from the ui action `data` are used as the
  initial list (no second LLM call). `PatchReviewList`: per patch title, lines, reasoning, `keywordsAdded`,
  original vs replacement, ACCEPT/REJECT toggles; APPLY ACCEPTED → `applyPatches` → editor content → SAVE AS NEW
  VERSION (`createResume`) or OVERWRITE (`updateResume`).
- **patches.js** (pure, node-tested): `findOverlaps(patches)`, `validatePatch(content, patch)` (`content.slice(
  startChar, endChar) === originalSubstring`), `applyPatches(content, patches, acceptedIds)` → `{ content,
  applied: id[], skipped: [{id, reason: "STALE"|"OVERLAP"}] }` — applies in descending `startChar`, skips
  overlapping/stale patches instead of failing the whole batch.
- **AtsPanel** (`ats`, rewrite of `ResumeScoreCard`): if `resumeWorkspace.analysis?.analysis_type === "score"`
  render it (existing `ResumeAnalysisPanel` layout); else pick a resume (+ optional job) → `scoreResume(...)`;
  delete the fake default rubric and the hardcoded "Alex Rivera" sample; empty state when nothing is scored.
- **ResumeGeneratorWorkspace** `({ workspace, onStart })`: drop `latexonline.cc`; preview = `workspace.pdfUrl`
  when present, else `compileLatex(workspace.latexCode)` once `status === "complete"` (and on a COMPILE click);
  add SAVE TO CATALOG (`createResume({ name, content: latexCode })` → open editor). The auto-save to the Resume
  Bank in ResumeStudio is kept.
- **SkillGapPanel** (`skill-gap`): AI gap analysis when `analysis_type === "gap"`; else compare `user.skills`
  with the skills of a picked campus/market job (no hardcoded role lists).
- **AiKeysPanel** (`settings.ai-keys`): providers + saved credentials (label · masked key · model), ADD KEY
  (provider, key, label, model; LOAD MODELS uses the pasted key) → `saveLlmCredential`, REMOVE (ConfirmDialog);
  keys never appear in chat or Redux state; the input is cleared after save.

### 13.5 tpo (backend: PLACEMENTS.md, JOB-FEED.md, AUTH-FACULTY.md)
Files: `pages/CompanyMode.jsx`, `features/tpo/{DrivesPanel, DriveForm, ApplicantsPanel, OfferForm,
PlacementAnalyticsPanel, TpoCalendarPanel, JobFeedAdminPanel, FacultyPanel, IssueReportsPanel}.jsx`,
`features/tpo/mappers.js`, the four components, `lib/api/admin.js`.
- **DrivesPanel** `({scope})`: `listDrives({status, query})`; status filter; CREATE (`params.create`) with
  `DriveForm` (title, company (tpo only; company scope uses its own), description, salary/CTC, location,
  employment type, application deadline, drive date, min CGPA, max backlogs, branches, graduation years,
  skills, selection process, application URL) → `toDrivePayload(form)` (`mappers.js`, node-tested; field names
  per PLACEMENTS.md) → `createDrive`; EDIT (`updateDrive`), CLOSE / DELETE (ConfirmDialog), APPROVE (tpo, company
  drafts); VIEW APPLICANTS → `openPanel(scope==="company" ? "company.applicants" : "tpo.applicants", {jobId})`;
  `params.jobId` opens that drive's detail.
- **ApplicantsPanel** `({scope})`: drive picker when no `jobId`; `listApplicants(jobId, {status})` table (name,
  branch, CGPA, status, resume link, applied at); status change (shortlisted/test/interview/offered/rejected…,
  per PLACEMENTS.md) with note → `updateApplicationStatus`; bulk select + status; EXTEND OFFER → `OfferForm` →
  `createOffer`.
- **OfferManagement** (rewrite, `tpo.offers`): stats, status filter (`params.status`), search, table, show
  `total`; MARK PLACED (confirm), OVERRIDE (status + reason), NEW OFFER (`params.create` + `applicationId`).
- **PolicyConfigPanel**: `getPlacementPolicy()`; 404/empty → defaults with a notice "No policy saved yet —
  showing defaults" (no silent fallback); SAVE; lint fix (set-state-in-effect).
- **PlacementAnalyticsPanel** (`tpo.analytics`): `getPlacementStats(params)` → KPI tiles (students, placed %,
  offers, median/max CTC), applications by status and per-branch table with CSS bars (no chart library).
- **TrainingScheduler** (rewrite, `tpo.training`): list + search; NEW/EDIT program modal (title, type,
  instructor, capacity, schedule rows) → `createProgram`/`updateProgram`; DELETE (confirm); ROSTER
  (`listProgramEnrollments`); no divide-by-zero on capacity 0.
- **TpoCalendarPanel**: `listDrives()` → `PlacementCalendar` (drive dates + deadlines).
- **JobFeedAdminPanel** (`tpo.job-feed`): `getJobFeedSyncStatus()` (running, last runs, per-source counts/
  errors, schedule, totals), SYNC NOW (ConfirmDialog → `triggerJobFeedSync()`; 202 → "Sync started"), live
  updates from `job-feed:sync`; browse the feed with `listMarketJobs` (read-only import); `params.runId`
  highlights that run.
- **FacultyPanel** (`tpo.faculty`): `listFaculty({query})` (name, email, department, designation, status
  invited/active/inactive); INVITE (`params.invite`) form → `inviteFaculty` (the backend emails a
  `/reset-password/<token>?invite=1` link); RESEND INVITE; DEACTIVATE/REACTIVATE (`updateFaculty`).
- **IssueReportsPanel** (`tpo.issues`): `listIssueReports({status})`, status change; when the endpoint is 404,
  show "Issue inbox is not enabled on this server."
- **GapAnalysisPanel**: keep the AI-driven view; show `error` with RUN AGAIN (`runAIFeature("gap-analysis")`).
- **CompanyMode**: §12.4.

### 13.6 shell-owned feature fixes
- **InterviewWorkspace**: the campus-job picker uses `listCampusJobs()` (placements.js) + `toJobVM`; "PRACTICE FOR
  THIS ROLE" sends `details.selected_job = toAgentJob(vm)` and `journeyJobSelected(toAgentJob(vm))`; drop
  `api.getJobs`; the search input padding works after §15.2.
- **LearningRecommendationWorkspace**: legacy `api.getMyInterviews()` now hits `GET /interviews?limit=20` (§14.1);
  render scores as `/100` with thresholds 80/60 (not `/10`, 8/6); show `learningWorkspace.error` with TRY
  AGAIN; preselect `params.interviewId`; navigation via `openPanel("interview")` + `setAgentMode`; fix lint.
- **RecommendedResources**: ignore empty terms (empty role no longer matches every section).
- **VoiceInterviewInput**: use `ack.answerSeconds` from `interview:audio:start` when present (60 s fallback).
- **GgsipuConnect**: fix the set-state-in-effect lint error; behaviour unchanged.
- **PROutreach**, **AlumniConnect**: no functional change; must keep working through the legacy facade (§14.1).

## 14. API client modules (`src/lib/api/*.js`)

Conventions: every function uses `http` (paths relative to `API_BASE` = `${API_ORIGIN}/api/v1`), returns the
normalized value in the "Returns" column, lets `ApiClientError` propagate. Ids are URL-encoded with
`encodeURIComponent`. List normalizers accept both a bare array and `{<plural>|items, total…}`.

### 14.1 `src/lib/api.js` — legacy facade (shell)
- Re-exports `API_ORIGIN`, `API_BASE` from `src/lib/config.js` (http.js, socket.js import config.js directly).
- Keeps every existing function name and argument list and still resolves with the **full envelope**
  (`{statusCode, data, message, success}`) so existing callers keep reading `res.data`. Implemented as
  `http({ ...config, raw: true })`; rejections are converted to an axios-compatible error: `error.response =
  { status, data: { success:false, message, errors, data:null } }` with `errors = Array.isArray(details) ?
  details : details ? [details] : []` (PROutreach checks `errors.includes("GMAIL_NOT_CONNECTED")`).
  `getGgsipuCaptcha` / `connectGgsipu` stay on plain axios with the Bearer header and `withCredentials: true`
  (blob + captcha cookie). `saveGeneratedResume` passes `timeout: 120000`.
- Path change: `getMyInterviews` → `GET /interviews?limit=20` (the route that exists).
- Deprecated, not deleted this wave (no callers after it): `uploadResume`, `getResumeScore`, `getInterviewById`,
  `getJobs`, `getAllDrives`, `getMatchedDrives`, `createDrive`, `applyToDrive`, training ×3, offers ×8, policy ×2,
  `discoverAlumni` — each gets `/** @deprecated use src/lib/api/<module>.js */`.

### 14.2 `src/lib/api/auth.js` (shell)
| Function | Method + path | Body / query | Returns |
|---|---|---|---|
| `loginOrRegister({email, password, role})` | POST `/auth/login-or-register` (`withCredentials: true`) | `{email, password, role}` | `{ user, accessToken, isNewUser }` |
| `googleLogin({credential, role})` | POST `/auth/google` **VERIFY AUTH-FACULTY** (`withCredentials: true`) | `{credential, role}` | `{ user, accessToken }` |
| `getMe()` | GET `/auth/me` | – | `User` |
| `updateMe(patch)` | PATCH `/auth/me` | §6.5 fields **VERIFY AUTH-FACULTY** (rollNumber, section, semester, department, designation, employeeId) | `User` |
| `logoutRequest()` | POST `/auth/logout` (`withCredentials: true`) | – | `void` |
| `forgotPassword(email)` | POST `/auth/forgot-password` | `{email}` | `void` |
| `resetPassword(token, password)` | POST `/auth/reset-password/:token` | `{password}` | `void` |

### 14.3 `src/lib/api/notifications.js` (shell) — NOTIFICATIONS.md
| Function | Method + path | Returns |
|---|---|---|
| `listNotifications({limit = 30, before, unreadOnly})` | GET `/notifications` | `{ items, unread, nextBefore }` |
| `getUnreadCount()` | GET `/notifications/unread-count` | `number` |
| `markNotificationRead(id)` | POST `/notifications/:id/read` | `Notification` |
| `markAllNotificationsRead()` | POST `/notifications/read-all` | `{ updated }` |
| `deleteNotification(id)` | DELETE `/notifications/:id` | `void` |
| `getPushPublicKey()` | GET `/notifications/push/public-key` | `{ enabled, publicKey }` |
| `subscribePush(subscription)` | POST `/notifications/push/subscribe` `{subscription}` | `void` |
| `unsubscribePush(endpoint)` | POST `/notifications/push/unsubscribe` `{endpoint}` | `void` |
| `getNotificationPreferences()` | GET `/notifications/preferences` | `{ email, push, mutedTypes }` |
| `updateNotificationPreferences(prefs)` | PUT `/notifications/preferences` | `{ email, push, mutedTypes }` |

`src/lib/api/issueReports.js` (shell): `submitIssueReport({name, email, description, pageUrl})` → POST
`/issue-reports` **VERIFY** (issue-reports module; Matchy body `{name, email, description}`) → `{ message }`.

### 14.4 `src/lib/api/attendance.js` (attendance-teacher writes; attendance-student imports) — ATTENDANCE.md
| Function | Method + path | Body / query | Returns |
|---|---|---|---|
| `listCourses({status} = {})` | GET `/attendance/courses` | `?status` | `Course[]` (data array or `data.courses`) |
| `createCourse(body)` | POST `/attendance/courses` | ATTENDANCE fields + `autoEnroll` | `Course` (`data.course`) |
| `getCourse(courseId)` | GET `/attendance/courses/:id` | – | `{ course, students: [], upcoming: [], summary: null\|… }` (missing arrays → `[]`) |
| `updateCourse(courseId, patch)` | PATCH `/attendance/courses/:id` | | `Course` (`data.course ?? data`) |
| `archiveCourse(courseId)` | DELETE `/attendance/courses/:id` | | `Course\|null` |
| `addStudents(courseId, {emails, userIds})` | POST `/attendance/courses/:id/students` | | `{ added, notFound: [] }` |
| `removeStudent(courseId, studentId)` | DELETE `/attendance/courses/:id/students/:studentId` | | `void` |
| `autoEnroll(courseId)` | POST `/attendance/courses/:id/auto-enroll` | | `{ added }` |
| `regenerateJoinCode(courseId)` | POST `/attendance/courses/:id/join-code` | | `{ joinCode }` |
| `joinCourse(joinCode)` | POST `/attendance/courses/join` | `{joinCode}` | `Course` (`data.course`) |
| `generateSessions(courseId, {days})` | POST `/attendance/courses/:id/generate` | | `{ created, sessions: [] }` |
| `getCourseReport(courseId)` | GET `/attendance/courses/:id/report` | | `{ course, held, students: [], defaulters: [] }` |
| `notifyDefaulters(courseId, {threshold, message})` | POST `/attendance/courses/:id/notify-defaulters` | | `{ notified }` |
| `listSessions({from, to, courseId, status} = {})` | GET `/attendance/sessions` | query | `Session[]` (data array or `data.sessions`) |
| `createSession(body)` | POST `/attendance/sessions` | `{courseId, startsAt \| when, durationMinutes, room, topic, mode}` | `Session` (`data.session`) |
| `autoScheduleSession(body)` | POST `/attendance/sessions/auto` | `{courseId, durationMinutes, earliest, latest, preferredDays, preferredStart, preferredEnd, topic, room}` | `{ session, reason }` |
| `getSession(sessionId)` | GET `/attendance/sessions/:id` | | `{ session, course, roster: [], stats, myRecord: null\|… }` |
| `updateSession(sessionId, patch)` | PATCH `/attendance/sessions/:id` | | `Session` |
| `cancelSession(sessionId, {reason})` | POST `/attendance/sessions/:id/cancel` | | `Session` |
| `startSession(sessionId, {geo} = {})` | POST `/attendance/sessions/:id/start` | `{geo?}` | `{ session, qr }` |
| `endSession(sessionId)` | POST `/attendance/sessions/:id/end` | | `{ session, stats }` |
| `getSessionQr(sessionId)` | GET `/attendance/sessions/:id/qr` | | `Qr = { token, version, expiresAt, url, rotationSeconds }` |
| `markRecord(sessionId, {studentId, status, note})` | POST `/attendance/sessions/:id/records` | | `{ record, stats }` |
| `downloadSessionCsv(sessionId)` | GET `/attendance/sessions/:id/export.csv` (`responseType: "blob"`) | | `Blob` |
| `submitScan({sessionId, token, deviceId, geo})` | POST `/attendance/scan` | exactly these keys (no `v`) | `ScanResult = { status, markedAt, session, course, summary }` |
| `getMySummary()` | GET `/attendance/me/summary` | | `{ courses: [], overall }` |
| `getMyHistory({courseId, limit = 50} = {})` | GET `/attendance/me/history` | | `HistoryRecord[]` (`data.records`) |
| `getMySchedule({days = 7} = {})` | GET `/attendance/me/schedule` | | `Session[]` |
| `joinPresenter(sessionId)` | socket `emitWithAck("attendance:presenter:join", {sessionId})` | | `{ ok, qr?, stats?, error? }` |
| `leavePresenter(sessionId)` | `socket.emit("attendance:presenter:leave", {sessionId})` | | `void` |
Also exported: `ATTENDANCE_EVENTS = { QR: "attendance:qr", MARKED: "attendance:marked", SESSION:
"attendance:session", CONFIRMED: "attendance:confirmed" }`, `ATTENDANCE_ERROR_MESSAGES` (code → text below) and
`attendanceErrorMessage(error)` (code lookup, else `errorMessage(error)`):
`INVALID_TOKEN` "This QR code isn't valid. Scan the code your teacher is showing.", `TOKEN_EXPIRED` "This QR code
has expired. Scan the code on the screen again.", `SESSION_NOT_LIVE` "Attendance for this class isn't open.",
`NOT_ENROLLED` "You're not enrolled in this course. Ask your teacher for the join code.", `ALREADY_MARKED` "Your
attendance is already marked for this class.", `DEVICE_ALREADY_USED` "This phone was already used to mark another
student in this class.", `OUT_OF_RANGE` "You seem to be outside the classroom. Move closer and scan again.",
`LOCATION_REQUIRED` "This class needs your location. Allow location access and scan again.",
`TOO_MANY_ATTEMPTS` "Too many attempts. Wait a minute and try again.", `SCHEDULE_CONFLICT` "That time overlaps
another class.", `NO_FREE_SLOT` "No free slot found in that window.", `NOT_FOUND` "Not found.", `FORBIDDEN`
"You don't have access to this.", `VALIDATION` "Some details are invalid.".

### 14.5 `src/lib/api/placements.js` (opportunities) — **VERIFY every path against PLACEMENTS.md**
| Function | Method + path | Returns |
|---|---|---|
| `listCampusJobs({query, location, minPackageLpa, eligibleOnly, page, limit} = {})` | GET `/jobs` (`q=query`) | `{ items: JobVM[], total, page, hasNextPage }` |
| `getCampusJob(jobId)` | GET `/jobs/:id` | `JobVM` (`data.job ?? data`) |
| `applyToJob(jobId, {resumeId, coverNote} = {})` | POST `/jobs/:id/apply` | `Application` |
| `listMyApplications({status} = {})` | GET `/applications/my` | `Application[]` |
| `withdrawApplication(applicationId)` | POST `/applications/:id/withdraw` (gap-audit alt: DELETE `/applications/:id`) | `Application\|null` |
| `listMyOffers()` | GET `/offers/my` | `Offer[]` |
| `acceptOffer(offerId)` | POST `/offers/:id/accept` | `Offer` |
| `rejectOffer(offerId, reason)` | POST `/offers/:id/reject` `{reason}` | `Offer` |
| `withdrawOfferAcceptance(offerId, reason)` | POST `/offers/:id/withdraw` `{reason}` | `Offer` |
| `listTrainingPrograms()` | GET `/training` | `Program[]` |
| `listMyTraining()` | GET `/training/my` | `Enrollment[]` |
| `registerForTraining(programId)` | POST `/training/:id/register` | `Enrollment` |
| `getPlacementCalendar({from, to})` | GET `/calendar` (optional endpoint; 404 → `null`) | `CalendarEvent[] \| null` |
Expected shapes (normalize if PLACEMENTS differs): `Application {_id, job:{_id,title,company}, status, timeline:
[{status, at, note}], resume?, createdAt}`; `Offer {_id, status: extended|accepted|rejected|withdrawn|expired|
placed, offerType: normal|dream|super-dream, companyName, roleTitle, packageLpa, expiresAt, academicYear,
isDreamEligible, currentAcceptedPackage, dreamMultiplier, tpoOverride, statusHistory:[{status, changedAt, note}]}`;
`Program {_id, title, description, type, instructor, capacity, enrolledCount, status, schedule:[{date, time,
venue}]}`; `Enrollment {_id, program: Program, completionStatus, attendance: [], certificateUrl}`.

### 14.6 `src/lib/api/jobFeed.js` (opportunities) — JOB-FEED.md §7 (present)
| Function | Method + path | Returns |
|---|---|---|
| `listMarketJobs({query, category, jobType, workType, location, source, sort, page, limit} = {})` | GET `/job-feed` (`q=query`) | `{ items: JobVM[], page, limit, total, hasNextPage, filters }` |
| `getMarketJob(jobId)` | GET `/job-feed/:id` | `JobVM` (`data.job`) |
| `listMarketCategories()` | GET `/job-feed/categories` | `[{ value, count }]` |
| `listMarketSources()` | GET `/job-feed/sources` | `SourceInfo[]` |
| `listSavedJobs({status, page, limit} = {})` | GET `/job-feed/saved` | `{ items: SavedJobView[], counts, page, limit, total, hasNextPage }` |
| `saveMarketJob(jobId, {status, notes} = {})` | PUT `/job-feed/saved/:jobId` | `SavedJobView` (`data.item`) |
| `removeSavedJob(jobId)` | DELETE `/job-feed/saved/:jobId` | `void` |

### 14.7 `src/lib/api/resumes.js` (resume) — **VERIFY paths against RESUME-BYOK.md**
| Function | Method + path | Returns |
|---|---|---|
| `listResumes()` | GET `/resumes` | `Resume[]` (`data.resumes ?? data`) |
| `createResume({name, content})` | POST `/resumes` | `Resume` |
| `getResume(resumeId)` | GET `/resumes/:id` | `{ resume, content }` |
| `updateResume(resumeId, {name, content})` | PUT `/resumes/:id` | `Resume` |
| `deleteResume(resumeId)` | DELETE `/resumes/:id` | `void` |
| `activateResume(resumeId)` | POST `/resumes/:id/activate` | `Resume` |
| `duplicateResume(resumeId, {name})` | POST `/resumes/:id/duplicate` | `Resume` |
| `compileLatex(latex)` | POST `/resumes/compile` `{latex}` | `Blob` (application/pdf) |
| `scoreResume({resumeId, jobId, jobSource})` | POST `/resumes/:id/score` | `ScoreResult` |
| `listBankResumes()` | GET `/resume-bank` (exists) | `BankResume[]` |
| `getBankResumeUrl(bankResumeId)` | GET `/resume-bank/:id/access` (exists) | `string` url |
`compileLatex` must surface the compiler log: call `http.post("/resumes/compile", {latex}, { responseType:
"blob", timeout: 120000, validateStatus: (s) => s !== 401 })` (401 still goes through the refresh interceptor);
when the resolved Blob's `type` is not `application/pdf`, read `await blob.text()`, parse JSON if possible and
throw `new ApiClientError({ status: 422, code: parsed?.errors?.[0]?.code || "COMPILE_FAILED", message:
parsed?.message || text.slice(0, 2000) })`.

### 14.8 `src/lib/api/llm.js` (resume) — **VERIFY against RESUME-BYOK.md**
| Function | Method + path | Returns |
|---|---|---|
| `listLlmProviders()` | GET `/llm/providers` | `Provider[]` (`id, label, defaultModel, configured, model, maskedApiKey, credentials:[{id, label, model, maskedApiKey}]`) |
| `listProviderModels(provider, {apiKey})` | POST `/llm/providers/:provider/models` | `{ provider, models }` |
| `saveLlmCredential(provider, {apiKey, model, label})` | PUT `/llm/credentials/:provider` | `{ credentialId, label, provider, model, maskedApiKey }` |
| `deleteLlmCredential(provider, credentialId)` | DELETE `/llm/credentials/:provider/:credentialId` | `void` |
| `tailorResume({resumeId, resumeContent, jobId, jobSource, credentialId, provider, model, manualJobDescription, fileType = "tex"})` | POST `/llm/tailor` (Matchy used POST `/llm/chat`) | `{ requiresManualJD, message, patches, missingKeywordsFound, totalPatches }` |

### 14.9 `src/lib/api/admin.js` (tpo)
| Function | Method + path | Contract |
|---|---|---|
| `listDrives({status, query, scope} = {})` | GET `/jobs` with `?manage=true&status&q` | PLACEMENTS **VERIFY** → `{ items, total }` |
| `getDrive(jobId)` / `createDrive(payload)` / `updateDrive(jobId, patch)` | GET `/jobs/:id` / POST `/jobs` / PATCH `/jobs/:id` | PLACEMENTS **VERIFY** |
| `closeDrive(jobId)` / `deleteDrive(jobId)` / `approveDrive(jobId)` | POST `/jobs/:id/close` / DELETE `/jobs/:id` / POST `/jobs/:id/approve` | PLACEMENTS **VERIFY** |
| `listApplicants(jobId, {status})` | GET `/jobs/:id/applications` | PLACEMENTS **VERIFY** → `Application[]` with `student` |
| `updateApplicationStatus(applicationId, {status, note})` | PATCH `/applications/:id/status` | PLACEMENTS **VERIFY** |
| `listOffers({status, q, page, limit})` | GET `/offers` | → `{ offers, total }` |
| `createOffer(body)` / `markOfferPlaced(offerId)` / `overrideOffer(offerId, {newStatus, note})` | POST `/offers` / POST `/offers/:id/place` / POST `/offers/:id/override` | PLACEMENTS **VERIFY** |
| `getPlacementPolicy()` / `savePlacementPolicy(policy)` | GET `/offers/policy` / POST `/offers/policy` | PLACEMENTS **VERIFY**; policy `{academicYear, enforceOneOffer, allowDreamUpgrade, dreamMultiplier, superDreamMultiplier, maxPendingOffers, offerExpiryDays}` |
| `getPlacementStats({academicYear, branch})` | GET `/placements/stats` | PLACEMENTS **VERIFY** |
| `listPrograms()` / `createProgram(b)` / `updateProgram(id, p)` / `deleteProgram(id)` / `listProgramEnrollments(id)` | GET `/training` / POST `/training` / PATCH `/training/:id` / DELETE `/training/:id` / GET `/training/:id/enrollments` | PLACEMENTS **VERIFY** |
| `triggerJobFeedSync()` / `getJobFeedSyncStatus()` | POST `/job-feed/sync` → `{run, alreadyRunning}` / GET `/job-feed/sync/status` | JOB-FEED §7.4–7.5 |
| `listFaculty({query})` / `inviteFaculty(body)` / `resendFacultyInvite(id)` / `updateFaculty(id, patch)` | GET `/faculty` / POST `/faculty/invite` / POST `/faculty/:id/resend-invite` / PATCH `/faculty/:id` | AUTH-FACULTY **VERIFY** |
| `listIssueReports({status})` / `updateIssueReport(id, {status})` | GET `/issue-reports` / PATCH `/issue-reports/:id` | issue-reports **VERIFY** |
| `listAgentToolAudit({limit})` | GET `/agent-tools/audit` | AGENT-TOOLS §3 |

## 15. Design system (all new panels use it)

### 15.1 Existing primitives (`src/index.css`) — exact definitions
| Class | Definition |
|---|---|
| `.card-stark` | `background:#fff; border:1.5px solid #000; border-radius:0; padding:1rem` |
| `.btn-primary` | `background:#000; color:#fff; border:1.5px solid #000; font-weight:700; border-radius:0; padding:.45rem .9rem; display:inline-flex; align-items:center; gap:.4rem; cursor:pointer; transition: background-color .15s, color .15s`; `:hover{background:#262626}` |
| `.btn-secondary` | same box with `background:#fff; color:#000`; `:hover{background:#f5f5f5}` |
| `.input-stark` | `border:1.5px solid #000; background:#fff; border-radius:0; padding:.45rem .75rem; font-weight:500`; `:focus{outline:none; background:#fafafa}` |
| `.badge-stark` | `border:1.5px solid #000; background:#fff; color:#000; font-size:.75rem; font-weight:700; padding:.125rem .5rem; border-radius:0; display:inline-flex; align-items:center; gap:.25rem` |
| `.shadow-bold` / `.shadow-bold-sm` / `.shadow-bold-lg` | subtle shadows `0 1px 3px rgba(0,0,0,.08)` / `0 1px 2px rgba(0,0,0,.05)` / `0 4px 6px -1px rgba(0,0,0,.1)` |
| animations | `.animate-drawer-slide` (.28s), `.animate-drawer-slide-out` (.24s), `.animate-fade-overlay` (.25s), `.animate-fade-overlay-out` (.22s), `.animate-item-up` (.35s) |
`src/App.css` is Vite template CSS that nothing imports — shell deletes it; nobody uses its classes.

### 15.2 CSS change (shell, decided in this contract)
Today these classes are unlayered and therefore beat Tailwind utilities (colored badges render white,
`btn-primary bg-red-600` renders black, `p-*`/`px-*` on them are ignored). Shell moves all component classes and
animation classes into `@layer components { … }` so utilities override them, and adds (verified with Tailwind
4.3.3): `@utility border-1.5 { border-width: 1.5px; }` and the same for `border-t-1.5`, `border-b-1.5`,
`border-l-1.5`, `border-r-1.5` (32 existing usages generated nothing); `@utility scrollbar-hide {
scrollbar-width: none; &::-webkit-scrollbar { display: none; } }`; `@keyframes fadeIn` +
`@utility animate-fadeIn { animation: fadeIn .25s ease-out both; }`; `.shadow-bold-md` (`0 2px 4px
rgba(0,0,0,.08)`) in the components layer; `html { -webkit-tap-highlight-color: transparent; }` in base. Effect
to know: accent colors and spacing written on stark elements now show; the only class combination that becomes
unreadable is ResumeStudio's header (`card-stark bg-black` with black text) — resume rewrites it.

### 15.3 Visual language
- Ink black on white; page `#f8fafc`; panels `bg-gray-50`/`bg-gray-100`; square corners everywhere (only the PR
  composer and the LaTeX editor keep their own palettes); no gradients; system font stack only.
- Accents = pastel Tailwind 100/200 shades: green success, yellow pending/highlight, red error/danger, blue info,
  purple AI, orange expired. Emphasis cards (QR frame, confirm cards) may use `shadow-[4px_4px_0_0_#000]`.
- Typography: labels/titles UPPERCASE `font-black` or `font-extrabold`; sizes `text-[9px]`–`text-xs` for chrome,
  `text-sm`/`text-base`/`text-lg font-black uppercase tracking-tight` for titles; body `text-xs font-medium`/
  `text-[11px]`; numbers `tabular-nums`; ids, emails, codes, join codes `font-mono`.
- Icons: lucide-react only (`h-3.5 w-3.5` in buttons, `h-5 w-5` in headers, `h-8 w-8` in tiles).

### 15.4 Recipes
- Panel header: `<div className="mb-4 flex items-center justify-between border-b-2 border-black pb-3"><div className="flex items-center gap-2"><Icon className="h-5 w-5"/><h3 className="text-sm font-black uppercase">TITLE</h3></div><span className="badge-stark text-[10px]">TAG</span></div>`
- Tool tile: `card-stark group flex min-h-48 cursor-pointer flex-col items-center justify-between bg-white p-4 text-center transition-all hover:-translate-y-0.5 hover:bg-gray-50` with a `bg-black p-3.5 text-white` icon box, title, 2-line description, footer `border-t-[1.5px] border-black pt-2` with badge + faux "OPEN →" `btn-primary px-2 py-1 text-[10px]`.
- Back bar: `btn-secondary px-3 py-1.5 text-xs` "← BACK TO … HOME" + `badge-stark bg-black text-white` title.
- Tabs: `px-3 py-1.5 text-xs font-black uppercase`; active `bg-black text-white`, inactive `bg-gray-100 hover:bg-gray-200`.
- Table: `w-full border-collapse border-2 border-black text-left text-xs`; head row `bg-black text-white uppercase`; cells `border-2 border-black p-2`; wrap in `overflow-x-auto`.
- Empty state: `border-2 border-dashed border-gray-400 bg-gray-50 p-8 text-center` + gray icon + `text-xs font-black uppercase` title + `text-[11px] text-gray-500` copy.
- Loading: `Sparkles animate-spin` + UPPERCASE label in `bg-yellow-100 border-2 border-black` pill.
- Modal: backdrop `fixed inset-0 z-50 bg-black/50 p-4`, box `card-stark max-h-[90vh] w-full max-w-md overflow-y-auto` (full screen < sm).
- Toggle: `h-6 w-12 border-2 border-black` track with a square knob (PolicyConfigPanel `ToggleRow`).
- Score/progress bar: `h-2.5 border border-black bg-gray-100` + inner colored div `style={{width: pct + "%"}}`.

### 15.5 `STATUS_COLORS` (`src/ui/statusColors.js`) — use these, never ad-hoc colors
```js
attendance: { present: "bg-green-200", late: "bg-yellow-200", absent: "bg-red-200", excused: "bg-blue-100" },
standing:   { safe: "bg-green-200", warning: "bg-yellow-200", critical: "bg-red-200", "no-data": "bg-gray-100" },
session:    { scheduled: "bg-blue-100", live: "bg-black text-white", ended: "bg-gray-200", cancelled: "bg-red-100 line-through", missed: "bg-orange-100" },
application:{ applied: "bg-blue-100", shortlisted: "bg-purple-100", test: "bg-yellow-100", interview: "bg-yellow-200", offered: "bg-green-200", selected: "bg-green-200", rejected: "bg-red-100", withdrawn: "bg-gray-200" },
offer:      { extended: "bg-blue-100", accepted: "bg-green-200", rejected: "bg-red-100", withdrawn: "bg-gray-200", expired: "bg-orange-100", placed: "bg-black text-white" },
tracker:    { saved: "bg-yellow-100", applied: "bg-blue-100", interviewing: "bg-purple-100", offer: "bg-green-200", rejected: "bg-red-100" },
priority:   { low: "bg-gray-100", normal: "bg-blue-100", high: "bg-red-200" },
```

### 15.6 Mobile requirements (must hold at 360×640, portrait and landscape)
- No horizontal page scroll; tables scroll inside `overflow-x-auto`; touch targets ≥ 44 px (`min-h-11`) for
  primary actions; inputs ≥ 16 px font on phones (`text-base sm:text-xs`) to avoid iOS zoom.
- Use `h-dvh`/`min-h-dvh` (not `h-screen`) and respect safe areas (`pb-[env(safe-area-inset-bottom)]` on fixed
  bottom bars).
- `< lg`: one pane at a time (§10). Modals and the notification panel are full-screen `< sm`.
- `/attend`, `ScanPanel`, `/present/:sessionId`, `StudentAttendancePanel`, `StudentSchedulePanel` and
  `LiveSessionPanel` are designed phone-first (one column, large primary buttons, no hover-only affordances).
- Camera, geolocation, push and service workers need a secure context: test phones with `npm run cert` +
  `npm run dev:lan` (https://<LAN-IP>:5173). Over plain http the QR deep link still works (native camera app →
  `/attend`), but the in-app scanner and geolocation show their "needs https" messages.

## 16. Gap-audit fixes → owner

| Problem (gap-audit / sih-frontend ref) | Fix | Owner |
|---|---|---|
| Header routing forces modes without role checks (§4.3, AGT-2) | header routes + copilot actions through `applyUiActions` | shell |
| `latestUiTarget` computed but unused; hardcoded UI branches (§4 C, D16) | panel registry + applier | shell |
| `mode:none`, `invalid request`, `AI backend unreachable` leave workspaces stuck (AGT-3) | §8.3 step 5 | shell |
| Raw header chips (AGT-5) | `headerLabel()` | shell |
| `newChatStarted`/`conversationOpened` keep `learningWorkspace` (AGT-6) | reset it | shell |
| Streaming flag persisted → pulsing bubble; hydration writes to guest key | §7.2, §6.1 | shell |
| No 401 handling / logout API / token validation on boot (AUTH-1) | session thunks + http.js | shell |
| Client-fabricated user on login; hardcoded `@ipu.ac.in`; no teacher/company login; Google dead code (AUTH-2/3) | §6.3–6.4 | shell |
| Forgot/reset password UI missing (AUTH-4) | ForgotPasswordForm + `/reset-password/:token` | shell |
| Fake access requests (WelcomeModeSelect, AccessDeniedView) (AUTH-7) | removed | shell |
| Duplicate `allowedModes`; company lands on AccessDenied | `modes.js` | shell |
| No notifications UI (NOTIF-1); fake drawer toggles | §9 | shell |
| `crypto.randomUUID` crash on LAN http | already polyfilled; keep `polyfills.js` first | shell |
| `/interviews/my` 404 (INT-2 FE side); learning score shown `/10`; error never shown | §13.6 | shell |
| RecommendedResources shows everything for empty role | §13.6 | shell |
| Hardcoded 60 s answer window | §13.6 | shell |
| Unused `remark-gfm`, `App.css`, assets, `StudentGgsipuLogin`, placeholder Google client id | remove / env | shell |
| CSS cascade hides utilities; `border-1.5` etc. generate nothing (§8.2) | §15.2 | shell |
| No ErrorBoundary | §10 | shell |
| Fake badges ("3 BEST MATCHES", "UPCOMING SESSIONS"), "Alex Rivera" fallbacks (JOB-6) | StudentMode / drawer / welcome rewrites | shell |
| Always-empty application tracking (JOB-1 FE) | `ApplicationsPanel` | opportunities |
| `undefined% FIT`, `MIN CGPA undefined`, `isEligible:true` hardcode, `matchPercentage:100` (JOB-2, AIJ-1 FE) | `toJobVM` + DriveCard rules | opportunities |
| Apply calls missing `/drives/:id/apply` | `applyToJob` | opportunities |
| Wishlist header unhandled (AIJ-2 FE) | §8.3 step 6 (shell) + SAVED tab (opportunities) | shell + opportunities |
| Student offers / training screens call missing routes; crash on empty schedule (OFF-1, TRN-1, TRN-3) | rewrites §13.3 | opportunities |
| Calendar month computed once; deadlines only (CAL-1, JOB-5 FE) | §13.3 | opportunities |
| Upload/ATS 404 + fake rubric + sample resume (RES-1) | AtsPanel / CatalogPanel | resume |
| `latexonline.cc` third-party compile (RES-2) | `compileLatex` (Tectonic) | resume |
| Static skill-gap roles (RES-3); Matchy JD leak, all-or-nothing apply | SkillGapPanel, TailorPanel, `patches.js` | resume |
| ResumeStudio header invisible after CSS fix | rewrite header | resume |
| TPO COMING SOON tools; read-only job postings (TPO-2, JOB-4) | Drives/Applicants/Analytics panels | tpo |
| Offer management / policy / training scheduler dead or silent (OFF-1, TRN-2) | rewrites §13.5 | tpo |
| Company mode unreachable / broken payload / fake verified badge (CMP-1) | CompanyMode + DrivesPanel | tpo (+ shell for login tab) |
| Second AI job overwrites the first (TPO-1 FE side) | "NEW JOB" starts a new chat session | shell |
| No attendance UI (D18) | §13.1, §13.2 | attendance-teacher, attendance-student |

ESLint errors today (each owner fixes its own): AccessDeniedView, GgsipuConnect, GoogleAuthButton,
LearningRecommendationWorkspace, StudentGgsipuLogin (deleted), `vite.config.js` and
`public/interview-pcm-worklet.js` → shell, by adding `eslint.config.js` blocks: `files: ["vite.config.js",
"scripts/**/*.{js,mjs}", "test/**/*.js"]` with `globals.node`; `files: ["public/interview-pcm-worklet.js"]` with
`globals.audioWorklet`; `files: ["public/sw.js"]` with `globals.serviceworker`. OfferManagement,
PolicyConfigPanel, TrainingScheduler, CompanyMode → tpo; ResumeScoreCard → resume; StudentOffers, TrainingHub →
opportunities.

## 17. Environment variables and dev setup

| Variable (`frontend/.env`) | Default | Meaning |
|---|---|---|
| `VITE_API_BASE_URL` | empty | Backend origin without `/api/v1`. Empty = same origin (dev proxy or a production reverse proxy serving `/api` and `/socket.io`). |
| `VITE_GOOGLE_CLIENT_ID` | empty | Google Identity Services web client id (same OAuth client as backend `CLIENT_ID`). Empty → no Google button and no `GoogleOAuthProvider` (the placeholder id in `main.jsx` is removed). |
| `VITE_APP_NAME` | `Matchy Campus` | Product name in the header, sign-in screen, welcome message and `document.title` (set at runtime; `index.html` has the static title "Matchy Campus"). |
| `VITE_DEV_BACKEND_URL` (dev server only) | `http://127.0.0.1:8000` | Proxy target for `/api` and `/socket.io`. |
| `VITE_DEV_HOST`, `VITE_DEV_HTTPS` (dev server only) | unset | Set by `npm run dev:lan` (`lan`, `true`) with the cert from `npm run cert` in `.cert/`. |

`src/lib/config.js`: `const env = import.meta.env ?? {}` (node tests have no `import.meta.env`);
`API_ORIGIN = (env.VITE_API_BASE_URL || "").replace(/\/$/, "")`; `API_BASE = \`${API_ORIGIN}/api/v1\``;
`APP_NAME = (env.VITE_APP_NAME || "Matchy Campus").trim()`; `GOOGLE_CLIENT_ID = (env.VITE_GOOGLE_CLIENT_ID ||
"").trim()`; `IS_SECURE_CONTEXT = () => typeof window !== "undefined" && window.isSecureContext`.
`src/lib/socket.js`: `SOCKET_URL = API_ORIGIN || (typeof window !== "undefined" ? window.location.origin :
"http://localhost")`, `autoConnect: typeof document !== "undefined"`, token from `storage.getItem("token")`,
imports `./config.js`. The only edits to the seams: `src/lib/http.js` →
`import { API_BASE } from "./config.js";`, `src/lib/realtime.js` → `import { ensureSocketAuthentication, socket }
from "./socket.js";` (removes the api.js ↔ http.js import cycle the legacy facade would create and makes both
importable by `node --test`).
`index.html`: title "Matchy Campus", `<meta name="theme-color" content="#000000">`, description, `<link
rel="manifest" href="/manifest.webmanifest">`, viewport `width=device-width, initial-scale=1, viewport-fit=cover`.
Backend values the frontend depends on: `FRONTEND_URL` must be the origin phones open (QR links, reset/invite
emails, push URLs); `CORS` must allow that origin when `VITE_API_BASE_URL` is a different host.

## 18. Build, lint and tests

- `npm run build` and `npm run lint` (0 errors) must pass after the wave; shell runs the final integration
  build. Shell adds to `package.json`: `"test": "node --test test/"`.
- Test files live in `frontend/test/`, are plain ESM `.js`, import `./helpers/env.js` first (shell: in-memory
  `localStorage`/`sessionStorage` via `Object.defineProperty(globalThis, …, {configurable: true})`, a minimal
  `window` (EventTarget + `location` = `http://localhost:5173/` + `isSecureContext:true`), no `document` so the
  socket never connects), and stub HTTP with `http.defaults.adapter = async (config) => ({ data:
  {statusCode:200, success:true, message:"ok", data: …}, status: 200, statusText: "OK", headers: {}, config })`.
- Acceptance tests (each must exist and pass):
  - **shell** `test/workspace.*.test.js`: the 12 scenarios of UI-ACTIONS.md §12; `test/shell.*.test.js`:
    (1) `AGENT_MODE_BY_HEADER` maps all five `copilot:*` headers to `copilot` and every pre-existing header to the
    same agent mode as before; (2) `responseReceived` with `copilot:tool` then `copilot:confirm` chunks sets
    `toolCalls`, `pending`, `options` on the bot message and `requestFailed` marks running calls `error`;
    (3) `AI backend timeout` (`isEnd`, `data.type:"error"`) on a `job-creation` request leaves
    `jobCreationWorkspace.status === "error"`; (4) a stored message with `streaming:true` hydrates as `false`;
    (5) `allowedModesFor`/`defaultModeFor`/`needsModeChoice` for all six roles and an unknown role;
    (6) legacy `api.getMyInterviews()` issues `GET /interviews?limit=20` and resolves with the envelope;
    (7) a 409 `{errors:["GMAIL_NOT_CONNECTED"]}` through the facade yields
    `err.response.data.errors.includes("GMAIL_NOT_CONNECTED")`; (8) `listNotifications`/`getUnreadCount` paths and
    shapes.
  - **attendance-teacher** `test/attendance-api.test.js`: every §14.4 function issues the documented method + path
    + body; `listCourses` normalizes both `[..]` and `{courses:[..]}`; `listSessions` both `[..]` and
    `{sessions:[..]}`; `downloadSessionCsv` requests `responseType:"blob"`; `submitScan` sends exactly
    `{sessionId, token, deviceId, geo}`; `attendanceErrorMessage` returns the §14.4 text for each code and the
    server message for unknown codes. `test/attendance-teacher.*.test.js`: course form → payload mapping
    (timetable rows, settings bounds) in `courseForm.js`.
  - **attendance-student** `test/attendance-student.*.test.js`: `parseAttendUrl` — absolute URL, relative
    `/attend?s=a&t=b&v=3`, other origin accepted, missing `t` → null, `/other?s=a&t=b` → null, whitespace trimmed;
    `getDeviceId` stable across calls; scan controller — `TOKEN_EXPIRED` keeps scanning and ignores the same
    token, a new token is submitted, never more than 1 submit / 2 s and 6 / minute, `LOCATION_REQUIRED` retries
    once with geo, `ALREADY_MARKED` stops as terminal.
  - **opportunities** `test/opportunities.*.test.js`: `toJobVM` for a campus job, a `PublicExternalJob` and both
    `JobsListItem` kinds (JOB-FEED.md §12.10 fixture) → no `undefined` values in list fields, `matchScore` null
    when absent, `isEligible` null for external, `packageLpa` 12 from `"12 LPA"`, "Not mentioned" → null;
    `toAgentJob` keys; jobFeed/placements functions issue the documented paths (`q` query param for `query`).
  - **resume** `test/resume.*.test.js`: `applyPatches` applies in descending order, skips a stale patch and an
    overlapping patch without failing the others, keeps content unchanged when nothing is accepted;
    `compileLatex` returns the Blob for `application/pdf` and throws `ApiClientError` with the log text for a
    `text/plain` 422.
  - **tpo** `test/tpo.*.test.js`: `toDrivePayload(form)` maps form fields to PLACEMENTS field names (comma lists →
    arrays, numbers parsed, empty optional fields omitted); admin.js paths for drives, applicants, offers,
    policy, job-feed sync/status.
- Manual QA script (shell runs it once, with every module merged), on a phone over `npm run dev:lan`:
  (1) student signed in scans the presenter QR with the phone camera → present within 2 s, presenter count +1,
  QR rotates; (2) signed-out phone → sign in → "QR expired" path → SCAN AGAIN with the in-app scanner works;
  (3) a second student scanning the same displayed code sees "QR changed" and succeeds on the next code; (4) the
  teacher asks the copilot "schedule DBMS tomorrow 10am" → tool chip + CONFIRM → schedule panel opens on the new
  session; (5) a notification click opens the right panel; (6) TPO receiving a jobs-finder answer stays in TPO
  mode; (7) every page at 360 px wide has no horizontal scroll.

## 19. Cross-area dependencies and open questions

### 19.1 What other areas must match
1. **Agent tools / copilot**: tool handlers return `ui` objects shaped `{panel, params}` with panel ids and
   param names from UI-ACTIONS.md §3/§10; `open_panel` offers exactly UI-ACTIONS.md §4 per role; copilot chunks
   follow AGENT-TOOLS.md §6 (`copilot:*` headers, cumulative `tool_calls` / `ui_actions` with stable `id`s,
   `pending` + `options: ["Confirm","Cancel"]` on `copilot:confirm`). `resume_tailor_for_job` returns `jobSource`
   in `ui.params` and the patch payload in `ui.data` (UI-ACTIONS.md §10).
2. **Node relay**: forward `details.ui_context` into `meta_data.ui_context` (optional; nothing breaks if
   dropped); keep the terminal headers `invalid request`, `auth:required`, `error`, `AI backend unreachable`,
   `AI backend timeout`, `AI backend disconnected` with `isEnd: true` and `data.type: "error"`.
3. **Notifications**: every `notify()` caller stores `ui` from UI-ACTIONS.md §11; web-push payload is JSON
   `{title, body, url, tag, notificationId, priority}` with `url` = UI-ACTIONS.md §9 deep link on `FRONTEND_URL`
   (same origin only); socket events `notification:new` `{notification}` and `notification:count` `{unread}`.
4. **Attendance**: QR deep link `${FRONTEND_URL}/attend?s=&t=&v=`; error codes in `errors[0].code`;
   `GET /courses` and `GET /sessions` may return a bare array or `{courses}`/`{sessions}` (client normalizes).
5. **AUTH-FACULTY**: `POST /auth/login-or-register` signs in EXISTING `teacher` and `company` accounts when
   `role` matches (no self-registration for them) and answers a role mismatch with `403` +
   `errors[0] = {code:"ROLE_MISMATCH", role:"<actual>"}`; `PATCH /auth/me` accepts `rollNumber, section, semester`
   (students) and `department, designation, employeeId` (teachers); `POST /auth/google {credential, role}` →
   `{user, accessToken}`; reset and invite emails link to `${FRONTEND_URL}/reset-password/<token>` (`?invite=1`
   for faculty invites); `/auth/refresh-token` keeps returning `{accessToken}` from the httpOnly cookie.
6. **PLACEMENTS / RESUME-BYOK / issue-reports / faculty**: the paths marked VERIFY in §14; if they differ, the
   owning frontend agent adapts its API module only.
7. **JOB-FEED**: §9.2 notification should use panel `tpo.job-feed` (the `tpo.jobfeed` spelling is accepted as a
   deprecated alias, UI-ACTIONS.md §3.8); `mode:jobparser:jobslist` items follow JOB-FEED.md §12.5.
8. **Hosting**: SPA fallback for `/attend`, `/present/:id`, `/reset-password/:token`, `/report-issue`;
   `FRONTEND_URL` = the origin phones open; CORS allows it when the API is on another host.

### 19.2 Open questions for the product owner (defaults chosen here)
1. Recruiter (company) accounts: shipped as TPO-provisioned accounts with their own mode (default) or hidden
   for this release?
2. Single-use QR tokens mean a crowded class needs several scan attempts per student (the scanner retries
   automatically). Acceptable, or should the token stay valid for its whole rotation window (multi-use)?
3. Resume tailoring without a student's own key: allow a server-side model as fallback, or require BYOK
   (default: BYOK required; the panel links to AI KEYS)?
4. The CSS layering fix (§15.2) makes accent colors that were silently suppressed visible across the app
   (default: apply it).
5. Logging out unsubscribes web push on that device (default: yes, privacy on shared phones).
6. `admin` sees exactly the TPO workspace (default); a separate super-admin UI is out of scope.
