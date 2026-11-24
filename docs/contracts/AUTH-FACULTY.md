# Contract: Identity, roles, faculty and recruiter provisioning, issue reports, demo data

Owner area: identity. All paths are relative to the repo root `/Users/sanyampandey/Minor Project /`. The directory name ends with a space, so always quote it.

This contract builds on `docs/contracts/ATTENDANCE.md`, `NOTIFICATIONS.md`, `AGENT-TOOLS.md` and the core seams in `backend/src/core/*`.

**Response envelope (unchanged).**
- Success: `{statusCode, data, message, success: true}` via `send()` or `Apiresponse`.
- Error: `{success: false, message, errors: [{code, ...}], data: null}` via `fail(status, message, code, extra)` from `core/http.js`.
- Every error the UI branches on carries `errors[0].code` (see §19).

**Dependencies.** No new npm dependencies are needed. The backend already has `google-auth-library`, `jsonwebtoken`, `bcrypt`, `nodemailer` and `luxon`. The frontend already has `@react-oauth/google`.

---

## 0. Files

### Backend: create
| path | purpose |
|---|---|
| `backend/src/models/auth-session.models.js` | `AuthSession`: refresh-token sessions (§2.2) |
| `backend/src/services/auth-session.service.js` | Issue, refresh and revoke sessions; cookies; `invalidateUserAccess` (§3) |
| `backend/src/services/auth-policy.service.js` | `normalizeEmail`, `isTeacherEmail`, `resolveRegistration`, `assertLoginAllowed`, `afterLogin` (§4) |
| `backend/src/services/account-mail.service.js` | Test seam `accountMailer {isConfigured, send}` plus templates: reset, invite, password-changed (§7.4) |
| `backend/src/services/google-identity.service.js` | Test seam `googleIdentity {isConfigured, verifyIdToken}` (§4.3) |
| `backend/src/services/user-profile.service.js` | `buildProfileUpdate(user, body)`, `toProfileSummary(user)` (§6) |
| `backend/src/utils/branch.js` | `canonicalBranch(value)` (§6.3) |
| `backend/src/utils/password.js` | `generateTemporaryPassword()`, `validateNewPassword(pw)` |
| `backend/src/modules/faculty/{index.js, faculty.routes.js, recruiters.routes.js, colleges.routes.js, provisioning.service.js, reveal-store.js, tools.js}` | §7, §8, §10 |
| `backend/src/modules/issue-reports/{index.js, issue-report.model.js, issue-reports.routes.js, issue-reports.service.js, tools.js}` | §9, §10 |
| `backend/scripts/seed-demo.js`, `backend/scripts/demo/seed.js`, `backend/scripts/demo/fixtures.js` | Demo seed (§16) |
| `backend/test/{auth.test.js, auth-google.test.js, faculty.test.js, issue-reports.test.js, seed-demo.test.js}` | §17 |

### Backend: modify
| path | change |
|---|---|
| `backend/src/models/user.models.js` | §2.1 |
| `backend/src/models/college.models.js` | Add `departments`; canonicalise branches (§2.3) |
| `backend/src/controllers/auth.controller.js` | Rewrite per §4–§6. Delete the dead `registerUser`/`loginUser`, the multi-line emoji console banners, and the reset-token log |
| `backend/src/routes/auth.routes.js` | Route table §5 plus rate limiters §12 |
| `backend/src/middlewares/auth.middleware.js` | Header-first `verifyJWT` with `isActive` and `tokenVersion` checks; export `optionalAuth` (§3.4) |
| `backend/src/websocket/auth-context.js` | Socket auth checks; `getInstitutionContext` prefers `user.college`; `buildProfile` adds role fields (§3.5) |
| `backend/src/utils/user-context-metadata.js` | Use the user's real college name and `user.designation` instead of the hardcoded GGSIPU constant (§3.5) |
| `backend/src/controllers/ggsipu.controller.js`, `backend/src/routes/ggsipu.routes.js` | §15 (delete `studentLogin`, student-only, enrollment conflict, canonical branch) |
| `backend/src/config/config.js` | Export the env vars in §13 |

### Backend: delete
- `backend/src/validations/auth.validation.js`. It is dead code; validation now happens inline with `fail(400, …, "VALIDATION", {field})`.

### Frontend: create, modify, delete
Details are in §14.
- **Create:** `src/lib/api/{auth.js, faculty.js, issue-reports.js}`, `src/components/{ResetPasswordScreen.jsx, ChangePasswordModal.jsx, ReportIssueModal.jsx}`, `src/components/tpo/{FacultyPanel.jsx, RecruitersPanel.jsx, IssueReportsPanel.jsx}`.
- **Modify:** `src/main.jsx`, `src/App.jsx` (auth blocks only), `src/components/{AuthScreen.jsx, GoogleAuthButton.jsx, ProfileModal.jsx, SidebarDrawer.jsx}`, `src/pages/AdminMode.jsx` (3 tool tiles), `src/lib/http.js` (auth:expired detail), `frontend/.env.example`.
- **Delete:** `src/components/StudentGgsipuLogin.jsx`.

---

## 1. Roles and how each account comes to exist

| role | how the account is created | domain rule | UI mode on login |
|---|---|---|---|
| `student` | Self-registration via password or Google | Email domain must equal a `College.domain` (exact match) | `student` (WelcomeModeSelect shown) |
| `teacher` | **(a)** TPO/admin invite (§7), with any email domain. **(b)** Self-registration when the email is in `TEACHER_EMAILS` | (b) only: the email domain must be a registered college domain, and the teacher joins that college | `teacher` |
| `tpo` | Bootstrap: `TPO_EMAIL` plus `TPO_INITIAL_PASSWORD`, or Google sign-in with a verified `TPO_EMAIL`. Also the demo seed | The college is upserted from the email domain on bootstrap | `tpo` |
| `company` (recruiter) | TPO/admin invite only (§7), with any domain, linked to a `Company` | none | `company` |
| `alumni` | Self-registration (existing behaviour) | Any domain | `alumni` |
| `admin` | Database only. No API creates admins | none | `tpo` |

**Golden rule:** an **existing** user always signs in with their **stored** role. The `role` sent by the form matters only when a brand-new account is being registered. `TPO_EMAIL` is reserved and can only ever register as `tpo`. Emails in `TEACHER_EMAILS` always register as `teacher`, whatever role is requested.

Role aliases accepted in request bodies:
- `faculty` maps to `teacher`
- `recruiter` maps to `company`

---

## 2. Data model

### 2.1 `User` (modify `backend/src/models/user.models.js`)

**Add these fields:**

| field | type | notes |
|---|---|---|
| `tokenVersion` | Number, default 0 | Copied into the access-token claim `tv`. Incrementing it kills every access token of the user immediately. Add it to `SENSITIVE_USER_FIELDS` so it is stripped from JSON |
| `mustChangePassword` | Boolean, default false | Set by invite or admin reset. The UI forces `ChangePasswordModal` |
| `tempPasswordExpiresAt` | Date | Checked only while `mustChangePassword` is true |
| `invitedBy` | ObjectId → User | |
| `invitedAt` | Date | |
| `lastLoginAt` | Date | Set on every successful password or Google login |
| `deactivatedAt` | Date | |
| `deactivatedBy` | ObjectId → User | |

The existing `isActive` (default true), `department`, `designation`, `employeeId`, `rollNumber`, `section`, `semester` and `company` fields are reused as they are.

**Change these:**
- `refreshToken`: add `select: false` and a deprecation comment. It is never written again because sessions now live in `AuthSession`.
- `TPO.ref`: change `"Tpo"` to `"TPO"` (gap-audit AUTH-6).
- Add the index `{college: 1, role: 1, isActive: 1}`.

**Methods:**
- `generateAccessToken()` signs `{_id, email, name, role, tv: this.tokenVersion || 0}` with `ACCESS_TOKEN_SECRET`, `expiresIn: ACCESS_TOKEN_EXPIRY || "1d"`.
- `generateRefreshToken(sessionId)` signs `{_id, sid: sessionId}` with `REFRESH_TOKEN_SECRET`, `expiresIn: REFRESH_TOKEN_EXPIRY || "10d"`.
- `generatePasswordResetToken()`:
  - creates 32 random bytes as hex
  - stores the sha256 of it
  - sets the expiry to now plus `PASSWORD_RESET_TTL_MINUTES` (default 30)
  - returns the raw token
- `isPasswordCorrect(pw)` returns `false` when there is no stored password or the input is not a string. It never throws.

**Export** `USER_SAFE_PROJECTION = "-password -refreshToken -passwordResetToken -passwordResetExpiry"`.

Any `.lean()` read of users whose result reaches a client must use this projection, because the `toJSON` transform does not run on lean results.

### 2.2 `AuthSession` (new, `backend/src/models/auth-session.models.js`, collection `auth_sessions`)

Ported from Matchy `personal_project/backend/src/models/refresh-token.model.js` and `services/token.service.js`: hash-at-rest, TTL expiry, `revokedAt`.

| field | type | notes |
|---|---|---|
| `user` | ObjectId → User, required, index | |
| `tokenHash` | String, required, `select: false` | sha256 hex of the refresh JWT |
| `expiresAt` | Date, required | Equals the refresh JWT `exp`. TTL index `{expiresAt: 1}, {expireAfterSeconds: 0}` |
| `revokedAt` | Date, default null | |
| `revokedReason` | enum `logout` \| `logout_all` \| `password_reset` \| `password_change` \| `admin_reset` \| `deactivated` \| `session_limit` | |
| `lastUsedAt` | Date | Updated on refresh |
| `userAgent` | String, max 300 | |
| timestamps | | |

Index: `{user: 1, revokedAt: 1, expiresAt: 1}`.

**Sessions are not rotated.** Two reasons:
- Several tabs share one cookie, so rotation makes concurrent refreshes race and log users out.
- Users need several devices at once. For example, a teacher presents the QR code on a laptop and uses a phone.

**At most 10 active sessions per user.** After issuing a new session, revoke the oldest extra sessions with reason `session_limit`.

### 2.3 `College` (modify `backend/src/models/college.models.js`)
- Add `departments: { type: [String], default: [] }`.
- Values in `branches` and `departments` pass through `canonicalBranch()` on every API write.
- Unchanged:
  - `name`
  - `domain` (unique, lowercase)
  - `tpo` (the single TPO slot, ref User)
  - legacy `tpos`, which stays unused

### 2.4 `IssueReport` (new, `backend/src/modules/issue-reports/issue-report.model.js`, collection `issue_reports`)

Ported from Matchy `personal_project/backend/src/models/issue-report.model.js`, then extended.

| field | type | notes |
|---|---|---|
| `name` | String, required, trim, max 120 | |
| `email` | String, required, trim, lowercase, max 254 | |
| `description` | String, required, trim, max 5000 | |
| `page` | String, trim, max 300, default `""` | Screen or feature where it happened |
| `user` | ObjectId → User, default null, index | Set when the reporter is authenticated |
| `role` | String, default null | Snapshot of `user.role` |
| `college` | ObjectId → College, default null, index | Taken from the reporter's `user.college` |
| `userAgent` | String, max 300 | |
| `status` | enum `open` \| `in_progress` \| `resolved` \| `closed`, default `open`, index | |
| `note` | String, max 2000 | Triage note written by TPO or admin |
| `resolvedAt` | Date | |
| `handledBy` | ObjectId → User | |
| timestamps | | |

Indexes: `{createdAt: -1}`, `{status: 1, createdAt: -1}`, `{college: 1, createdAt: -1}`.

### 2.5 `Company`
No schema change is required. Recruiter invites find or create a `Company` by name:
- Case-insensitive exact match: `{name: {$regex: ^escapeRegex(name)$, $options: "i"}}`.
- Otherwise create it with `Company.create({name})`.

PLACEMENTS may add optional fields to `Company`, but `{name}` alone must remain valid.

---

## 3. Tokens, sessions, cookies and request authentication

### 3.1 Session service (`backend/src/services/auth-session.service.js`)

```js
issueSession(user, { userAgent }) → { accessToken, refreshToken, refreshExpiresAt, sessionId }
//  1. new AuthSession({user}) (unsaved, _id known)
//  2. refreshToken = user.generateRefreshToken(session._id)
//  3. expiresAt = jwt exp; tokenHash = sha256(refreshToken)
//  4. save; enforce the 10-session cap
//  5. User.updateOne({_id}, {lastLoginAt: now})

refreshSession(refreshToken) → { user, accessToken, sessionId }
//  1. jwt.verify with REFRESH_TOKEN_SECRET (payload must contain _id and sid, else REFRESH_TOKEN_INVALID)
//  2. AuthSession.findOne({_id: sid, user: _id}).select("+tokenHash")
//  3. Require revokedAt null, expiresAt > now, and timingSafeEqual(hash, tokenHash), else 401 REFRESH_TOKEN_INVALID
//  4. Load the user. A missing user gives 401 REFRESH_TOKEN_INVALID.
//     An inactive user: revoke the session (reason "deactivated"), then 403 ACCOUNT_DISABLED
//  5. lastUsedAt = now
//  6. Return a NEW access token carrying the current tokenVersion. No rotation.

revokeSession(refreshToken, reason) → boolean
//  jwt.verify with {ignoreExpiration: true}, then match _id, user and tokenHash.
//  An invalid token is a no-op that returns false.

revokeAllSessions(userId, reason, { exceptSessionId } = {}) → number

currentSessionId(req) → string | null
//  From the refresh cookie (or body.refreshToken), verified and not revoked.

invalidateUserAccess(userId, reason, { exceptSessionId, kick = true }) → { tokenVersion, revoked }
//  $inc tokenVersion, then revoke all sessions (except exceptSessionId).
//  When kick is true:
//    emitToUser(userId, "auth:revoked", { reason })
//    then after 250 ms (timer.unref()): getIO()?.in(rooms.user(userId)).disconnectSockets(true)

setAuthCookies(res, { accessToken, refreshToken?, refreshExpiresAt? })
clearAuthCookies(res)
authCookieBase() → { httpOnly: true, sameSite, secure }
//  sameSite = AUTH_COOKIE_SAMESITE ∈ {strict, lax, none}, else "strict"
//  secure   = NODE_ENV === "production" || sameSite === "none"
```

### 3.2 Cookies

| cookie | value | path | lifetime |
|---|---|---|---|
| `accessToken` | Access JWT, kept for legacy and for `window.open` downloads | `/` | Session cookie |
| `refreshToken` | Refresh JWT | `/api/v1/auth` | `expires` = `AuthSession.expiresAt` |

- `clearAuthCookies` clears three cookies: `accessToken` at `/`, `refreshToken` at `/api/v1/auth`, and the legacy `refreshToken` at `/`.
- **No JSON response body ever contains `refreshToken`.**
- Browsers store and send the refresh cookie only when login, Google, refresh, logout and change-password requests use `withCredentials: true` (§14).

### 3.3 Revocation matrix

| event | `tokenVersion++` | sessions revoked | sockets kicked (`auth:revoked`) |
|---|---|---|---|
| `POST /auth/logout` | no | The presented session only | no (the client re-auths its socket anonymously) |
| `POST /auth/logout-all` | yes | All | yes, reason `logout_all` |
| Password reset via email link | yes | All | yes, reason `password_reset` |
| Self change-password | yes | All except the current cookie session | no. The response carries a fresh access token. |
| TPO/admin `reset-password` of a teacher or recruiter | yes | All | yes, reason `admin_reset` |
| Deactivation (`DELETE` or `PATCH isActive: false`) | yes | All | yes, reason `deactivated` |

### 3.4 `verifyJWT` and `optionalAuth` (`backend/src/middlewares/auth.middleware.js`)

```
token = Bearer header (preferred), else req.cookies.accessToken
  missing → 401 UNAUTHORIZED "Unauthorized request"
jwt.verify(ACCESS_TOKEN_SECRET)
  fails, payload has no ObjectId _id, or payload.typ === "agent-tool" → 401 UNAUTHORIZED "Invalid or expired access token"
user = User.findById(_id).select(USER_SAFE_PROJECTION)
  null → 401 UNAUTHORIZED
user.isActive === false
  → 401 ACCOUNT_DISABLED "This account has been deactivated. Contact your placement office."
(payload.tv ?? 0) !== (user.tokenVersion ?? 0)
  → 401 SESSION_REVOKED "Your session has ended. Please sign in again."
req.user = user
```

- `optionalAuth` runs the same steps, but on any failure it sets `req.user = null` and calls `next()`.
- `core/http.js` re-exports `verifyJWT` as `requireAuth`, so every module inherits this behaviour.
- `ACCOUNT_DISABLED` is a **401** here on purpose. The frontend's existing 401 path in `http.js` tries a refresh, the refresh answers 403 `ACCOUNT_DISABLED`, and the client then dispatches `auth:expired` with the code.

### 3.5 Socket and agent context

**`websocket/auth-context.js`:**
- `getAuthenticatedUser(socket)`:
  - Await the query inside `try`. This fixes the existing un-awaited return.
  - Return `null` (anonymous) when:
    - the token is invalid
    - `typ === "agent-tool"`
    - the user is missing or inactive
    - `tv` does not match `tokenVersion`
- `getEffectiveRole`: unchanged. Admin maps to `tpo`; `teacher`, `company` and `alumni` pass through.
- `getInstitutionContext(user, role)`:
  - Resolve the college by `user.college` first, then fall back to the email domain.
  - Return:
    - `college_id`
    - `college_name` (college name, else `user.collegeName`, else the domain)
    - `college_domain`
    - `branches`
    - `departments`
    - `tpo_user_id` when the role is `tpo`
- `buildProfile(user, details)`: additively include these keys:
  - `role`, `department`, `designation`, `section`, `semester`, `roll_number`
  - `graduation_year`: `details.graduation_year ?? user.passingYear ?? null`

**`utils/user-context-metadata.js`:**
- `college_name` comes from the user's college:
  - `College.findById(user.college)` name, or else `user.collegeName`
  - the existing GGSIPU constant only as the last fallback
- `designation` comes from `user.designation`, falling back to the legacy TPO document.

**Agent tools** (another area): `/api/v1/agent-tools/*` must also reject users with `isActive === false` when it re-loads the user. See §18.

---

## 4. Login and registration rules (`backend/src/services/auth-policy.service.js`)

### 4.1 `resolveRegistration({ email, requestedRole, password, via, googlePayload })` → `{ role, college }`
This runs only when no user exists for `email`. `via` is `"password"` or `"google"`.

```
domain  = email.split("@")[1]
college = await findCollegeForEmail(email)          // utils/student-college.js, exact domain match

if email === TPO_EMAIL:
    if via === "password":
        TPO_EMAIL or TPO_INITIAL_PASSWORD not configured → 503 TPO_BOOTSTRAP_DISABLED
        timingSafeEqual(password, TPO_INITIAL_PASSWORD) fails → 403 TPO_NOT_APPROVED
    // via "google": a verified Google email is enough
    college ??= College.findOneAndUpdate({domain},
                  {$setOnInsert: {name: domain.split(".")[0].toUpperCase(), domain}},
                  {upsert: true, returnDocument: "after"})
    college.tpo is set → 409 TPO_EXISTS
    return { role: "tpo", college }

if isTeacherEmail(email):            // TEACHER_EMAILS, case-insensitive exact match
    !college → 400 INVALID_DOMAIN "Teacher self-registration needs an email on a registered college domain. Ask your TPO to invite you."
    hostedDomainCheck()
    return { role: "teacher", college }

switch requestedRole:
    "alumni":  return { role: "alumni", college: null }      // any domain (existing)
    "teacher": 403 TEACHER_INVITE_REQUIRED "Faculty accounts are created by your placement office. Ask your TPO to invite you."
    "company": 403 RECRUITER_INVITE_REQUIRED "Recruiter accounts are created by the placement office."
    "tpo":     403 TPO_NOT_APPROVED "This email is not approved for TPO registration."
    "admin":   403 ROLE_NOT_ALLOWED
    default:   // "student"
        !college → 400 INVALID_DOMAIN "INVALID DOMAIN: Use an email domain registered to a college"
        hostedDomainCheck()
        return { role: "student", college }
```

`hostedDomainCheck()` applies only when `via === "google"` and `GOOGLE_REQUIRE_HOSTED_DOMAIN === "true"`. In that case `googlePayload.hd !== domain` gives 403 `HOSTED_DOMAIN_REQUIRED`.

### 4.2 `POST /auth/login-or-register` (aliases `/login`, `/register`)

1. **Validate input.**
   - `email = normalizeEmail(body.email)`, which trims, lowercases and checks `^[^\s@]+@[^\s@]+\.[^\s@]+$` with a maximum of 254 characters.
   - `password` must be a non-empty string.
   - Otherwise return 400 `VALIDATION`.
   - `requested = alias(body.role) || "student"`.
   - `explicit = body.role !== undefined`.
2. **Look up the user.** `user = await User.findOne({email})`.
3. **Existing user:**
   1. No stored `password` → 400 `PASSWORD_NOT_SET` "This account signs in with Google. Use Continue with Google, or Forgot password to set a password."
   2. Wrong password → 401 `INVALID_CREDENTIALS` "Incorrect email or password." Log only `[auth] login failed` with a masked email such as `a***@demo.edu`.
   3. Run `assertLoginAllowed(user, {via: "password"})`:
      - `isActive === false` → 403 `ACCOUNT_DISABLED`
      - `mustChangePassword && tempPasswordExpiresAt < now` → 401 `TEMP_PASSWORD_EXPIRED` "Your temporary password has expired. Ask your placement office for a new invite."

      The password is checked first so that only someone who knows the password learns the account state.
   4. Run `afterLogin(user)` (§4.4), then `issueSession`, then `setAuthCookies`.
   5. Return **200** `{ user, accessToken, isNewUser: false, roleAdjusted: explicit && requested !== user.role }`.
4. **New user:**
   1. `{role, college} = resolveRegistration(...)`.
   2. Unless the role is `tpo`, run `validateNewPassword(password)`: 8–128 characters, else 400 `WEAK_PASSWORD`.
   3. Create the user:

      ```
      User.create({
        name: body.name?.trim().slice(0, 80) || nameFromEmail(email),
        email, password, role,
        authProvider: "local",
        college: college?._id,
        collegeName: college?.name,
      })
      ```

      `nameFromEmail` keeps the existing behaviour: title-cased local part.
   4. Role-specific steps:
      - `tpo`: claim `College.tpo` atomically with the existing `ensureCollegeTpoSlot`. On failure, delete the user and rethrow.
      - `student`: call `linkStudentToCollege(user, college)`.
   5. Issue the session and set cookies.
   6. Return **201** `{ user, accessToken, isNewUser: true, roleAdjusted }`.

   A concurrent duplicate registration hits E11000, which `app.js` maps to 409 `DUPLICATE`.

### 4.3 Google sign-in: `POST /auth/google`

`backend/src/services/google-identity.service.js` exports a mutable seam:

```js
export const googleIdentity = {
  isConfigured: () => Boolean(CLIENT_ID),
  verifyIdToken: async (idToken) =>
    (await new OAuth2Client(CLIENT_ID).verifyIdToken({ idToken, audience: CLIENT_ID })).getPayload(),
};
```

Steps:
1. `!googleIdentity.isConfigured()` → 503 `GOOGLE_NOT_CONFIGURED`.
2. `idToken = body.credential || body.idToken`. A non-string or missing value gives 400 `VALIDATION`.
3. Verify the token.
   - A throw from verification → 401 `GOOGLE_TOKEN_INVALID`. **There is no fallback**, and `body.email`, `body.name` and `body.googleId` are never read.
   - `!payload.email` → 401 `GOOGLE_TOKEN_INVALID`.
   - `payload.email_verified !== true` → 403 `EMAIL_NOT_VERIFIED`.
4. **Existing user** (looked up by `normalizeEmail(payload.email)`):
   1. `user.googleId && user.googleId !== payload.sub` → 403 `GOOGLE_ACCOUNT_MISMATCH`.
   2. Run `assertLoginAllowed(user, {via: "google"})`. Only `isActive` is checked; temp-password expiry does not apply.
   3. Fill in `googleId = payload.sub` if it is missing, and `profile = payload.picture` if it is empty.
   4. Run `afterLogin`, then issue the session.
   5. Return 200 with the same shape as §4.2.
5. **New user:**
   1. Run `resolveRegistration({..., via: "google", googlePayload: payload})`.
   2. Create the user with `{name: payload.name || nameFromEmail, email, role, authProvider: "google", googleId: payload.sub, profile: payload.picture, college, collegeName}`. There is no password.
   3. Apply the same role-specific steps, then issue the session.
   4. Return 201.

Setup note: the Google OAuth Web client (`CLIENT_ID`, which equals the frontend `VITE_GOOGLE_CLIENT_ID`) must list `http://localhost:5173` and the production origin under **Authorized JavaScript origins**. The GIS credential flow needs no redirect URI.

### 4.4 `afterLogin(user)`
- **student:**
  - The college is `user.college`, or else `findCollegeForEmail(user.email)`.
  - If a college is found, call `linkStudentToCollege(user, college)` (idempotent, existing helper) and set `collegeName` if it is empty.
- **tpo:**
  - If `user.college` is unset, set it from the domain college.
  - If that college has no TPO, claim the slot.
  - **Never fail a TPO login because of the slot.** This removes the existing 409 on login.
- **Other roles:** no-op.

Logging: replace every multi-line banner with one line, for example `console.info("[auth] login", {userId, role, via})`. Never log passwords, tokens, reset links or temporary passwords.

---

## 5. REST: `/api/v1/auth` (`backend/src/routes/auth.routes.js`)

| method | path | auth | limiter (§12) | request | `data` on success |
|---|---|---|---|---|---|
| GET | `/options` | public | none | | `{ appName, collegeDomains: [{domain, name}], google: {enabled}, passwordReset: {emailEnabled}, passwordMinLength: 8 }` |
| POST | `/login-or-register` (aliases `/login`, `/register`) | public | `authIp`, `loginEmail` | `{email, password, role?, name?}` | 200/201 `{user, accessToken, isNewUser, roleAdjusted}` |
| POST | `/google` | public | `authIp` | `{credential \| idToken, role?}` | 200/201 same as the row above |
| POST | `/refresh-token` | refresh cookie (or `body.refreshToken`) | `refresh` | | `{accessToken}` |
| POST | `/logout` | `optionalAuth` | none | | `{}`. Revokes the presented session and clears cookies. Always 200 |
| POST | `/logout-all` | `verifyJWT` | none | | `{revoked}` |
| POST | `/forgot-password` | public | `forgotIp`, `forgotEmail` | `{email}` | `{}` with the generic message |
| GET | `/reset-password/:token` | public | `reset` | | `{valid: true, email: "a***@demo.edu", expiresAt}` |
| POST | `/reset-password/:token` | public | `reset` | `{password}` | `{}` |
| POST | `/change-password` | `verifyJWT` | `changePassword` | `{currentPassword?, newPassword}` | `{accessToken, user}` |
| GET | `/me` | `verifyJWT` | none | | The user object itself, as today. `PROutreach.jsx` reads `response.data` |
| PATCH | `/me` | `verifyJWT` | none | §6 | The updated user object itself, as today. `ProfileModal.jsx` reads `res.data` |
| GET/GET/POST | `/google/gmail/authorize-url`, `/google/gmail/callback`, `/google/gmail/disconnect` | unchanged | | | unchanged |

The routes `/options`, `/me` and `PATCH /me` keep the existing `data` shapes. The data returned by `GET /me` never contains `password`, `refreshToken`, `passwordResetToken`, `passwordResetExpiry`, `tokenVersion`, `gmailRefreshTokenEncrypted` or `llmCredentials`.

### 5.1 `/options`
- `collegeDomains` lists every `College` sorted by name, up to 50.
- `google.enabled` is `googleIdentity.isConfigured()`.
- `passwordReset.emailEnabled` is `accountMailer.isConfigured()`.

### 5.2 `/forgot-password`
1. Validate `email` with `normalizeEmail`. Invalid input gives 400 `VALIDATION`.
2. `!accountMailer.isConfigured()` → 503 `EMAIL_NOT_CONFIGURED` "Password reset by email is not available on this server. Ask your placement office (TPO) to reset your password." This is a configuration-level answer and reveals nothing about the account.
3. Find the user. If the user exists and `isActive !== false`:
   1. Run `generatePasswordResetToken()` and save.
   2. Call `sendPasswordResetEmail(user, rawToken)` (§7.4). The link is `${FRONTEND_URL}/reset-password/${rawToken}`.
   3. If sending throws, log `[auth] reset email failed` without the link and still answer 200.
4. Users without a password (Google-only) **are** allowed. The reset sets their first password.
5. The answer is always 200: "If an account exists for that email, a reset link has been sent."

### 5.3 `/reset-password/:token`
- The token must match `^[a-f0-9]{64}$` and `User.findOne({passwordResetToken: sha256(token), passwordResetExpiry: {$gt: now}, isActive: {$ne: false}})` must find a user. Otherwise return 400 `RESET_TOKEN_INVALID`.
- **GET** does not consume the token.
- **POST** does the following:
  1. `validateNewPassword` → 400 `WEAK_PASSWORD`.
  2. Set the password and clear `passwordResetToken`, `passwordResetExpiry`, `mustChangePassword` and `tempPasswordExpiresAt`.
  3. Run `invalidateUserAccess(id, "password_reset")`.
  4. Send the security notification and email (§11).
  5. Message: "Password reset. Sign in with your new password."
- The token is single-use. A second POST returns 400 `RESET_TOKEN_INVALID`.

### 5.4 `/change-password`
- `newPassword` must pass `validateNewPassword` (400 `WEAK_PASSWORD`).
- `newPassword === currentPassword` → 400 `VALIDATION`.
- If the user has a stored password, `currentPassword` is required and must match, else 400 `INVALID_CURRENT_PASSWORD`. This is a 400 rather than a 401 so that `http.js` does not trigger a refresh.
- Users without a password (Google-only) may set one without `currentPassword`.
- Effects:
  1. Set the password, `mustChangePassword = false`, and unset `tempPasswordExpiresAt`.
  2. Run `invalidateUserAccess(id, "password_change", {exceptSessionId: currentSessionId(req), kick: false})`.
  3. Return a new access token (with the new `tv`) and the user.
  4. Re-set the `accessToken` cookie.
  5. Send the security notification and email.

### 5.5 `/logout` and `/logout-all`
- `/logout`:
  1. Run `revokeSession(cookie || body.refreshToken, "logout")`.
  2. Run `clearAuthCookies`.
  3. Return 200 "Logged out successfully".
- `/logout-all`:
  1. Run `invalidateUserAccess(req.user._id, "logout_all")`.
  2. Run `clearAuthCookies`.

---

## 6. Profile rules (`PATCH /auth/me`) and academic trust

### 6.1 `buildProfileUpdate(user, body)` → `{ set, ignored: [{field, reason}] }` (`user-profile.service.js`)

| field | student | teacher | tpo/admin | company | alumni | validation |
|---|---|---|---|---|---|---|
| `name` | ✓ | ✓ | ✓ | ✓ | ✓ | 2–80 characters |
| `profile` (avatar URL) | ✓ | ✓ | ✓ | ✓ | ✓ | `""` or an http(s) URL of at most 500 characters |
| `socialLinks` `{github, linkedin, leetcode, portfolio}` | ✓ | ✓ | – | – | ✓ | Strings of at most 300 characters, merged with the stored object |
| `branch` | ✓ (locked when GGSIPU-linked) | – | – | – | – | `canonicalBranch`, at most 60 characters |
| `cgpa` | ✓ (locked when GGSIPU-linked) | – | – | – | – | Number 0–10, rounded to 2 decimals |
| `passingYear` | ✓ | – | – | – | – | `^20\d{2}$` (stored as a String) |
| `collegeName` | ✓ | – | – | – | – | At most 120 characters |
| `skills` | ✓ | – | – | – | ✓ | Up to 50 strings, each at most 60 characters, trimmed and de-duplicated |
| `projects` | ✓ | – | – | – | – | Up to 20 items `{title ≤ 120, description ≤ 1000, skills ≤ 20, link ≤ 300}` |
| `certifications` | ✓ | – | – | – | – | Up to 30 items `{name, issuer, date, credentialUrl}`, each at most 300 characters |
| `experience` | ✓ | – | – | – | – | Up to 20 items `{title, company, duration ≤ 120, description ≤ 1000}` |
| `careerPreferences` | ✓ | – | – | – | – | `{preferredRoles ≤ 10, preferredLocations ≤ 10, expectedSalary ≤ 60}` |
| `department` | – | ✓ | – | – | – | `canonicalBranch`, at most 60 characters |
| `designation` | – | ✓ | ✓ | ✓ | – | At most 80 characters |

**Never editable through `/auth/me`:**
- Identity and access: `email`, `role`, `college`, `isActive`, `password`, `googleId`, `tokenVersion`, `mustChangePassword`
- Academic records: `ggsipu*`, `rollNumber`, `section`, `semester`
- Organisation: `employeeId` (set by the TPO), `company`
- Integrations: `llmCredentials`, `gmail*`, `notificationPreferences` (owned by NOTIFICATIONS)

Unknown or disallowed keys are ignored silently. The current UI sends only known keys.

### 6.2 GGSIPU lock rule
`isAcademicLocked(user) = user.role === "student" && user.ggsipuLinked === true`.

When the account is locked, `cgpa` and `branch` cannot be self-edited:
- A value equal to the stored value is a no-op.
- A different value is **ignored, not rejected**. It is recorded in `ignored`, and the response message becomes: "Profile updated. CGPA and branch are synced from GGSIPU and were not changed."
- These fields change only through `POST /ggsipu/connect` (a re-sync).

The ignore-rather-than-reject choice keeps the existing `ProfileModal`, which always sends `branch` and `cgpa`, working.

Other cases:
- Nothing applicable to save, and nothing ignored because of the lock → 400 `VALIDATION` "Please provide at least one field to update".
- Invalid values for allowed fields → 400 `VALIDATION` with `{field}`.

Students who are not GGSIPU-linked may still self-edit `cgpa` and `branch` in v1 (see open questions).

### 6.3 `canonicalBranch(value)` (`backend/src/utils/branch.js`)

Normalisation: lowercase, replace `&` with ` and `, strip punctuation, and collapse spaces. Then apply the first matching rule:

| result | rule |
|---|---|
| `AIML` | Matches `\b(aiml\|ai ml)\b`, or contains both "artificial intelligence" and "machine learning" |
| `AIDS` | Matches `\b(aids\|ai ds)\b`, or contains both "artificial intelligence" and "data science" |
| `CSE` | Matches `\b(cse\|cs)\b`, or contains "computer science" or "computer engineering" |
| `IT` | Matches `\bit\b`, or contains "information technology" |
| `ECE` | Matches `\bece\b`, or contains "electronics and communication" |
| `EEE` | Matches `\beee\b`, or contains "electrical and electronics" |
| `EE` | Matches `\bee\b`, or contains "electrical" |
| `ME` | Matches `\b(me\|mech)\b`, or contains "mechanical" |
| `CE` | Matches `\bce\b`, or contains "civil" |
| otherwise | The original trimmed value, cut to 60 characters |

This applies to student `branch`, teacher `department`, and `College.branches`/`departments` on write, the GGSIPU program name (§15) and the seed.

Example: GGSIPU's "BACHELOR OF TECHNOLOGY (COMPUTER SCIENCE AND ENGINEERING)" becomes `CSE`.

### 6.4 `toProfileSummary(user)` (identity part of `get_my_profile`)
Returns:
```
{
  id, name, email, role,
  college: {id, name, domain} | null,
  branch, section, semester, passingYear, rollNumber, cgpa, skills, ggsipuLinked,
  department, designation, employeeId,
  company: {id, name} | null,
  mustChangePassword,
}
```
Keys that do not apply to the role are omitted.

`get_my_profile` itself is **owned by the agent-tools module** (`agent-tools/common.tools.js`, AGENT-TOOLS §4). It calls this function and adds the resume count and attendance overall.

---

## 7. Faculty and recruiter provisioning (module `backend/src/modules/faculty/`)

Module export:
```js
{
  name: "faculty",
  mountPath: "/api/v1/faculty",
  router: facultyRouter,
  routers: [
    { path: "/api/v1/recruiters", router: recruitersRouter },
    { path: "/api/v1/colleges", router: collegesRouter },
  ],
  tools,
}
```

Every faculty and recruiters route uses `requireAuth, requireRole("tpo")`. Admin always passes. Any other role gets 403 `FORBIDDEN`.

### 7.1 Scoping: `resolveActorCollege(actor, collegeId?)`
- **tpo:** `actor.college`. If it is missing → 409 `NO_COLLEGE` "Your account is not linked to a college".
- **admin:** `collegeId` (from query or body) must exist, else 404. If absent, use `actor.college`.
  - For a **create**, if there is still no college → 400 `COLLEGE_REQUIRED`.
  - For a **list**, no college means all colleges.
- Reads and writes filter on `{_id, role: "teacher" | "company", college: scope}`. A document outside the scope gives 404 `NOT_FOUND`, which never confirms that it exists.

### 7.2 Teachers: `/api/v1/faculty`

| method | path | request | `data` |
|---|---|---|---|
| GET | `/` | Query `search?` (regex on name and email via `escapeRegex`), `department?`, `status=active\|inactive\|all` (default `all`), `page=1`, `limit=50` (max 100, use `intParam`), `collegeId?` (admin only) | `{items: FacultyDTO[], total, page, limit}`, sorted `{isActive: -1, name: 1}` |
| POST | `/` | `{name, email, department?, designation?, employeeId?, sendEmail?: true}` | **201** `{user: FacultyDTO, delivery: "email"\|"manual", temporaryPassword?, emailError?}` |
| POST | `/reveal` | `{revealId}` | `{email, temporaryPassword}` (one-time, §7.5) |
| GET | `/:id` | | `{user: FacultyDTO}` |
| PATCH | `/:id` | Any of `{name, department, designation, employeeId, isActive}` | `{user}` |
| DELETE | `/:id` | | `{user}` (deactivates) |
| POST | `/:id/reset-password` | `{sendEmail?: true}` | `{user, delivery, temporaryPassword?, emailError?}` |

Register `POST /reveal` before the `/:id` routes.

**FacultyDTO:**
```
{
  _id, name, email, role: "teacher",
  department, designation, employeeId,
  isActive, authProvider, mustChangePassword,
  inviteExpiresAt,                     // tempPasswordExpiresAt while mustChangePassword, else null
  invitedBy: {_id, name} | null, invitedAt,
  lastLoginAt, deactivatedAt,
  college: {_id, name, domain},
  courseCount?,
}
```
`courseCount` is included only when `mongoose.models.Course` is registered. It is one aggregate per page: `{teacher: {$in: ids}, status: "active"}` grouped by teacher. Do not import the attendance module directly.

**Validation** (400 `VALIDATION` with `{field}`):
- `name`: 2–80 characters
- `email`: `normalizeEmail`
- `department`: at most 60 characters, canonicalised
- `designation`: at most 80 characters
- `employeeId`: at most 40 characters
- PATCH with `email` or `role` → 400 `VALIDATION` "email and role cannot be changed"

**Create, in order:**
1. If `email === TPO_EMAIL` → 409 `EMAIL_RESERVED`.
2. If any user already has the email → 409 `EMAIL_EXISTS`, with `errors[0].existingRole` and `existingActive`. Roles are never converted.
3. `temp = generateTemporaryPassword()`.
4. Create the user:

   ```
   User.create({
     name, email, password: temp, role: "teacher", authProvider: "local",
     college, collegeName: college.name,
     department, designation, employeeId,
     mustChangePassword: true,
     tempPasswordExpiresAt: now + TEMP_PASSWORD_TTL_DAYS,
     invitedBy: actor._id, invitedAt: now,
   })
   ```

   The model's pre-save hook hashes the password.
5. **Delivery:**
   - If `sendEmail !== false && accountMailer.isConfigured()`, call `sendInviteEmail(...)`:
     - Success → `delivery: "email"`, and the response contains **no** password.
     - Failure → `delivery: "manual"`, plus `temporaryPassword` and `emailError: "Could not send the invite email"`.
   - Otherwise → `delivery: "manual"` plus `temporaryPassword`.
6. Send the welcome notification (§11).

**Rules for the temporary password:**
- It appears in exactly one HTTP response (the create or reset that produced it).
- It is never stored in plain text, never logged, and never sent to the LLM (§10).

**Deactivate** (`DELETE`, or `PATCH {isActive: false}`):
1. Set `isActive: false`, `deactivatedAt`, `deactivatedBy`, and unset the reset token fields.
2. Run `invalidateUserAccess(id, "deactivated")`.

There is no cascade. Courses and attendance history stay, and the TPO can still see them.

**Reactivate** (`PATCH {isActive: true}`): set `isActive: true` and unset `deactivatedAt`/`deactivatedBy`. Sessions stay revoked, so the user signs in again.

**Reset password:**
- On an inactive user → 409 `ACCOUNT_INACTIVE` "Reactivate the account first".
- Otherwise:
  1. Generate a new temp password and set `mustChangePassword: true` with a new expiry.
  2. Run `invalidateUserAccess(id, "admin_reset")`.
  3. Deliver it the same way as on create.

### 7.3 Recruiters: `/api/v1/recruiters`
These routes have the same shape and rules as `/faculty`, with these differences:
- The role is `company`.
- **Create** takes `{name, email, companyName? | companyId?, designation?, sendEmail?}`.
  - Exactly one of `companyName` or `companyId` is required, else 400 `VALIDATION`.
  - A `companyId` that does not exist gives 404.
  - The Company is found or created as in §2.5.
  - The user gets `company: companyId`, `college: actor college` and `collegeName`.
  - The create response adds `company: {_id, name}`.
- **List** filters are `search`, `company` (id or name regex) and `status`.
- **PATCH** allows `{name, designation, companyId | companyName, isActive}`.
- The welcome notification uses the recruiter template (§11).

**RecruiterDTO:**
```
{
  _id, name, email, role: "company", designation,
  company: {_id, name} | null,
  isActive, mustChangePassword, inviteExpiresAt,
  invitedBy, invitedAt, lastLoginAt, deactivatedAt,
  college: {_id, name, domain},
}
```

A recruiter account belongs to the college that invited it (one portal per account in v1).

### 7.4 Account mail (`backend/src/services/account-mail.service.js`)

```js
export const accountMailer = {
  isConfigured: () => isMailerConfigured(),
  send: (message) => sendMail(message),
};   // core/mailer.js; tests replace these properties
```

Every helper returns `{delivered: boolean, error?: string}`. Helpers never throw and never log message bodies.

| helper | subject | body (rendered with `renderEmail`) | action |
|---|---|---|---|
| `sendPasswordResetEmail(user, rawToken)` | `Reset your ${APP_NAME} password` | "We received a request to reset the password for {email}. The link expires in {PASSWORD_RESET_TTL_MINUTES} minutes. If you did not ask for this, ignore this email." | "Reset password" → `${FRONTEND_URL}/reset-password/${rawToken}` |
| `sendInviteEmail({user, temporaryPassword, inviter, college, kind})` | `You're invited to ${APP_NAME}` | "Hello {name}, {inviter.name} ({college.name}) created a {faculty \| recruiter} account for you. Email: {email}. Temporary password: {temp}. You will choose a new password after signing in. The temporary password expires on {date in APP_TIMEZONE}." | "Sign in" → `${FRONTEND_URL}/` |
| `sendPasswordChangedEmail(user)` | `Your ${APP_NAME} password was changed` | "Your password was changed on {date}. If this wasn't you, contact your placement office immediately." | none |

### 7.5 One-time reveal store (`reveal-store.js`)

This store exists for agent tools, so that the temporary password never passes through the LLM.

- `putReveal({ownerId, email, password})` → `revealId` (16 random bytes, base64url).
  - Entries are kept in an in-memory `Map` with a 10-minute TTL.
  - Expired entries are swept on every `put`.
- `takeReveal(revealId, ownerId)` → `{email, temporaryPassword}`, or `null` when the ID is missing, expired or owned by someone else.
  - A wrong owner does not delete the entry.
  - A successful read deletes it.
- `POST /api/v1/faculty/reveal` returns `takeReveal(revealId, req.user._id)`. A `null` result gives 404 `REVEAL_EXPIRED` "This password was already shown or has expired. Reset the password to issue a new one."
- The store is shared by teachers and recruiters.
- Single-process only, which is acceptable for this deployment.

---

## 8. Colleges: `/api/v1/colleges` (mounted by the faculty module)

| method | path | auth | request | `data` |
|---|---|---|---|---|
| GET | `/mine` | `requireAuth` (any user with a college) | | `{college: {_id, name, domain, branches, departments, tpo: {_id, name, email} \| null}}`. A user without a college gets 404 `NOT_FOUND` |
| PATCH | `/mine` | `requireRole("tpo")` | `{name? (2–120), branches? (max 30), departments? (max 30)}` | `{college}`. List entries are canonicalised and de-duplicated |
| GET | `/` | `requireRole("admin")` (only admin; a TPO gets 403) | | `{items: [college]}` |
| POST | `/` | `requireRole("admin")` | `{name, domain, branches?, departments?}` | **201** `{college}`. A duplicate domain gives 409 `DUPLICATE` |

`requireRole("tpo")` lets admin through as well. For admin-only routes, use an explicit `role === "admin"` check that returns 403 `FORBIDDEN`.

---

## 9. Issue reports (module `backend/src/modules/issue-reports/`)

Port sources:
- `personal_project/backend/src/models/issue-report.model.js`
- `controllers/issue-reports.controller.js`
- `routes/issue-reports.routes.js`

Module export: `{name: "issue-reports", mountPath: "/api/v1/issue-reports", router, tools}`.

| method | path | auth | request | `data` |
|---|---|---|---|---|
| POST | `/` | public plus `optionalAuth`; limiter `issueIp`, `issueEmail` | `{name?, email?, description, page?, website?}` | **201** `{id}`, message "Thanks for reporting this. We'll take a look soon." |
| GET | `/` | `requireAuth, requireRole("tpo")` | Query `status?`, `search?` (name, email, description), `page`, `limit` (≤ 100) | `{items: [report], total, page, limit, counts: {open, in_progress, resolved, closed}}` |
| PATCH | `/:id` | `requireAuth, requireRole("tpo")` | `{status?, note? (≤ 2000)}` | `{report}` |

**POST rules:**
- **Anonymous reporter:**
  - `name` (1–120) and `email` (regex `^[^\s@]+@[^\s@]+\.[^\s@]+$`, max 254) are required.
  - Missing fields → 400 `VALIDATION` "Name, email, and issue description are required."
  - A bad email → 400 `VALIDATION` "Please enter a valid email address."
- **Authenticated reporter:** `name`, `email`, `user`, `role` and `college` come from `req.user`. The body's name and email are ignored, so they cannot be spoofed.
- **Description:** 1–5000 characters after trim. Length violations return **400**, never 500. This fixes the Matchy bug.
- **Honeypot:** a non-empty `website` string returns the same 201 response but nothing is stored.
- `userAgent` is the request header cut to 300 characters.

**GET scope:**
- tpo: `{college: {$in: [tpo.college, null]}}`, meaning their college plus anonymous reports.
- admin: everything.
- `report` items: `{_id, name, email, description, page, status, note, role, user: {_id, name, role} | null, createdAt, updatedAt, resolvedAt}`.

**PATCH:**
- Setting `status` to `resolved` or `closed` sets `resolvedAt`.
- `handledBy` is set to the actor.
- If the reporter was a user, notify them (§11).
- An out-of-scope report gives 404 `NOT_FOUND`.

---

## 10. Agent tools (per `AGENT-TOOLS.md` §2)

### 10.1 Faculty module tools (`backend/src/modules/faculty/tools.js`)

| tool | roles | confirm | parameters | behaviour |
|---|---|---|---|---|
| `faculty_list` (catalogue) | tpo, admin | – | `{search?, department?, status?: "active"\|"inactive"\|"all" (default "active"), limit?: integer (default 20, max 50)}` | Uses `listProvisioned`. Summary example: "12 faculty at Demo Institute of Technology (11 active): CSE 6, IT 5, other 1." `data: {items: [{id, name, email, department, designation, isActive, courseCount}], total}`. `ui: {panel: "tpo.faculty", params: {search, department, status}}` |
| `faculty_invite` (catalogue) | tpo, admin | ✓ | `{name*, email*, department?, designation?}` | See below |
| `recruiters_list` (**extension**) | tpo, admin | – | `{search?, company?, status?, limit?}` | Same as `faculty_list` for recruiters, with `ui: {panel: "tpo.recruiters"}` |
| `recruiter_invite` (**extension**) | tpo, admin | ✓ | `{name*, email*, company*, designation?}` | Same contract as `faculty_invite`, with `ui: {panel: "tpo.recruiters", params: {highlightId, revealId?}}` |

**`faculty_invite` in detail:**
- **Preview.** Validates the arguments and throws the same errors as REST (`EMAIL_EXISTS`, `EMAIL_RESERVED`, `VALIDATION`) with no side effects. It returns:
  - `summary`: "Invite **{name}** ({email}) as {department} faculty?", followed by either "Login details will be emailed." (mailer configured) or "You will see a one-time temporary password in the Faculty panel."
  - `args`: the normalised arguments.
- **Handler.** Calls `inviteUser` with `sendEmail: true`. When delivery is `manual`, it calls `putReveal({ownerId: ctx.user._id, email, password})`. It returns:
  - `summary`: "Invited {name} as {department} faculty. Login details were emailed to {email}." or "… Open the Faculty panel to copy the one-time temporary password (valid 10 minutes)."
  - `data: {faculty: {id, name, email, department}, delivery}`
  - `ui: {panel: "tpo.faculty", params: {highlightId, revealId?}}`

**No tool summary, data, ui or preview ever contains a temporary password.**

When an admin has no college, the tools return `fail(400, "Link your account to a college or use the Faculty panel", "COLLEGE_REQUIRED")`.

### 10.2 Issue-reports module tool (`backend/src/modules/issue-reports/tools.js`)

| tool | roles | confirm | parameters | behaviour |
|---|---|---|---|---|
| `issue_report_create` (**extension**) | student, teacher, tpo, company, admin, alumni | ✓ | `{description*: "what went wrong, in the user's words", page?: "screen or feature"}` | See below |

- **Preview:** "File this issue report for the placement team? '{first 120 characters}'"
- **Handler:** creates the report with the `ctx.user` identity. It returns:
  - `summary`: "Filed your issue report #{last 6 characters of id}. The placement team will review it."
  - `data: {id}`

Extensions must be added as rows to AGENT-TOOLS §5.

---

## 11. Notifications and socket events emitted by this area

All notifications go through `notify()` from `backend/src/modules/notifications/notify.js`. Security email is sent directly through `accountMailer`, so it is delivered regardless of the user's email preference.

| trigger | `type` | recipients | title | body | `ui` | priority |
|---|---|---|---|---|---|---|
| Teacher invited | `system` | The new teacher | `Welcome to ${APP_NAME}` | "{inviter} added you as faculty{ in DEPT}. Create a course to start taking attendance." | `{panel: "teacher.schedule"}` | normal |
| Recruiter invited | `system` | The new recruiter | `Welcome to ${APP_NAME}` | "{inviter} invited you to recruit at {college}. Post a drive to reach students." | `{panel: "company.drives"}` | normal |
| Password reset or changed | `security.password_changed` | The user | "Your password was changed" | "If this wasn't you, contact your placement office immediately." | none | high |
| Issue report from an authenticated user | `issue.new` | The TPO(s) of the reporter's college plus all active admins, excluding the reporter and de-duplicated | "New issue report from {name}" | First 200 characters of the description | `{panel: "tpo.issues", params: {reportId}}` | low |
| Issue status changed | `issue.updated` | The reporter (when `report.user` is set) | "Your issue report is now {Resolved \| In progress \| Closed}" | `note` or "" | none | low |

Anonymous issue reports do not notify anyone, which avoids spam. They only appear in the list.

**Socket (server to client):**
- `auth:revoked` `{reason: "deactivated" | "password_reset" | "logout_all" | "admin_reset"}` is sent to room `user:<id>` 250 ms before `disconnectSockets(true)` (§3.1).
- There are no new client-to-server events.

---

## 12. Rate limits (`core/rate-limit.js`)

Limiters are created once per route file. The key is `req.ip`, plus `keyFn` when given. Every limiter answers 429 `TOO_MANY_ATTEMPTS`. Per-IP limits are generous on purpose, because a whole classroom shares one NAT IP at the start of a lecture.

| limiter | window | max | keyFn | used on |
|---|---|---|---|---|
| `authIp` | 15 min | 300 | none | login-or-register (and aliases), google |
| `loginEmail` | 15 min | 10 | normalised `body.email` | login-or-register (and aliases). Message: "Too many sign-in attempts for this account. Try again in 15 minutes." |
| `refresh` | 15 min | 600 | none | refresh-token |
| `forgotIp` | 60 min | 30 | none | forgot-password |
| `forgotEmail` | 60 min | 3 | normalised `body.email` | forgot-password |
| `reset` | 15 min | 20 | none | GET and POST reset-password |
| `changePassword` | 15 min | 10 | `req.user._id` (mounted after `verifyJWT`) | change-password |
| `issueIp` | 10 min | 10 | none | POST issue-reports |
| `issueEmail` | 60 min | 5 | `req.user?.email` or normalised `body.email` | POST issue-reports |

Tests opt in with `ENABLE_RATE_LIMIT_IN_TESTS=true` (existing behaviour of `rateLimit`).

---

## 13. Environment variables

Export these from `backend/src/config/config.js` and document them in `backend/.env.example`.

| name | default | meaning |
|---|---|---|
| `TEACHER_EMAILS` | `""` | Comma-separated emails, trimmed and lowercased into a `Set`. The first registration (password or Google) of one of these becomes `teacher`. The domain must be a registered college |
| `TPO_EMAIL` / `TPO_INITIAL_PASSWORD` | `""` | Existing. Reserved bootstrap TPO email and the password that allows its first password registration |
| `CLIENT_ID` | `""` | Existing. Google OAuth Web client ID. Empty disables `POST /auth/google` (503) |
| `GOOGLE_REQUIRE_HOSTED_DOMAIN` | `false` | When `"true"`, new student and teacher Google registrations require `payload.hd` to equal the email domain |
| `AUTH_COOKIE_SAMESITE` | `strict` | `strict` \| `lax` \| `none` for the auth cookies (and the GGSIPU session cookie, §15). `none` forces `Secure`. Use `none` only when the frontend and API are on different sites (HTTPS) |
| `ACCESS_TOKEN_SECRET` / `ACCESS_TOKEN_EXPIRY` | — / `1d` | Existing. The secret is required at boot |
| `REFRESH_TOKEN_SECRET` / `REFRESH_TOKEN_EXPIRY` | — / `10d` | Existing. Sign the refresh JWT, and the expiry equals the session lifetime |
| `PASSWORD_RESET_TTL_MINUTES` | `30` | Lifetime of the reset link |
| `TEMP_PASSWORD_TTL_DAYS` | `7` | Lifetime of the invite or admin-reset temporary password |
| `FRONTEND_URL` | `http://localhost:5173` | Existing. Base for reset and invite links |
| `APP_NAME` | `Matchy Campus` | Existing. Used in email subjects and notification titles |
| `SMTP_*` | | Existing (`core/mailer.js`). Unset means reset is disabled (503) and invites use manual delivery |
| `DEMO_PASSWORD` | generated | Seed only. One password for every demo account, at least 8 characters |
| `VITE_GOOGLE_CLIENT_ID` (frontend) | `""` | Must equal `CLIENT_ID`. Empty means no `GoogleOAuthProvider` and no Google button |

---

## 14. Frontend

### 14.1 API modules (all use `http` from `src/lib/http.js`, which unwraps the envelope to `data`)

**`src/lib/api/auth.js`.** `cred` is `{withCredentials: true}`:
```js
export const authApi = {
  options: () => http.get("/auth/options"),
  loginOrRegister: (b) => http.post("/auth/login-or-register", b, cred),
  google: ({ credential, role }) => http.post("/auth/google", { credential, role }, cred),
  logout: () => http.post("/auth/logout", {}, cred),
  logoutAll: () => http.post("/auth/logout-all", {}, cred),
  me: () => http.get("/auth/me"),
  updateMe: (patch) => http.patch("/auth/me", patch),
  forgotPassword: (email) => http.post("/auth/forgot-password", { email }),
  checkResetToken: (t) => http.get(`/auth/reset-password/${encodeURIComponent(t)}`),
  resetPassword: (t, password) => http.post(`/auth/reset-password/${encodeURIComponent(t)}`, { password }),
  changePassword: (b) => http.post("/auth/change-password", b, cred),
};
export const storeAccessToken = (token) => {
  localStorage.setItem("token", token);
  window.dispatchEvent(new CustomEvent("auth:token-refreshed", { detail: { token } }));
};
```
Dispatching `auth:token-refreshed` makes `realtime.js` re-authenticate the socket at once, so the socket joins `user:<id>` and receives notifications.

**`src/lib/api/faculty.js`:**
- `facultyApi`: `list(params)`, `get(id)`, `invite(body)`, `update(id, body)`, `deactivate(id)`, `resetPassword(id, body)`, `reveal(revealId)`
- `recruitersApi`: the same methods without `reveal`
- `collegesApi`: `mine()`, `updateMine(body)`

**`src/lib/api/issue-reports.js`:** `issueReportsApi`: `submit(body)`, `list(params)`, `update(id, body)`.

### 14.2 `src/lib/http.js`
In `refreshAccessToken`'s failure path, dispatch `new CustomEvent("auth:expired", {detail: {code}})`, where `code` is the refresh error's `errors[0].code`, for example `ACCOUNT_DISABLED` or `REFRESH_TOKEN_INVALID`.

### 14.3 `src/main.jsx`

```js
const GOOGLE_CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID || "").trim();
```
- Wrap `<App/>` in `GoogleOAuthProvider` **only** when this value is non-empty.
- Delete the hardcoded placeholder client ID.
- `frontend/.env.example` gains `VITE_GOOGLE_CLIENT_ID=` with the comment "must equal backend CLIENT_ID".

### 14.4 `AuthScreen.jsx` (rewrite; the `onAuthSuccess(user)` signature stays)
- **Options:** load `authApi.options()` on mount. On failure, use defaults: Google disabled, email reset disabled.
- **Role toggles:** four toggles, Student · Faculty (sends `teacher`) · TPO · Alumni. Helper text:
  - Student: "Use your college email (@demo.edu …)", built from `collegeDomains`, up to 3.
  - Faculty: "Use the temporary password from your invite."
  - TPO and Alumni: the existing copy.
- **Domain check:** delete the hardcoded `@ipu.ac.in` check. The server is authoritative.
- **Submit:**
  1. Call `authApi.loginOrRegister({email, password, role})`.
  2. Call `storeAccessToken(data.accessToken)`.
  3. Call `onAuthSuccess(data.user, {roleAdjusted})`.
- **Errors:** show `err.message`. Use friendlier text for these codes:
  - `ACCOUNT_DISABLED`
  - `TEACHER_INVITE_REQUIRED`
  - `INVALID_DOMAIN`
  - `TEMP_PASSWORD_EXPIRED`
  - `TOO_MANY_ATTEMPTS`
- **Forgot password:**
  - When `passwordReset.emailEnabled` is true, a "Forgot password?" link opens an inline email form. It calls `authApi.forgotPassword` and always shows the generic success text.
  - Otherwise show "Forgot your password? Ask your placement office (TPO) to reset it."
- **Google:** when `options.google.enabled && GOOGLE_CLIENT_ID`, render `<GoogleAuthButton role={authRole} …/>` under an "OR" divider.
- **Footer:**
  - A "Report an issue" link opens `<ReportIssueModal/>` (anonymous).
  - The brand text comes from `VITE_APP_NAME`, default "Matchy Campus".
- **Notice:** accept a `notice` prop (string) and show it as a banner, for example "Session expired" or "Password updated".

### 14.5 `GoogleAuthButton.jsx` (rewrite)
- **Props:** `{role = "student", onLoginSuccess, onError}`.
- **Render:**
  ```jsx
  <GoogleLogin
    onSuccess={({ credential }) => …}
    onError={() => onError("Google sign-in was cancelled or failed.")}
    useOneTap={false}
    theme="outline" size="large" shape="square" text="continue_with"
  />
  ```
- **On success:** call `authApi.google({credential, role})`, then `storeAccessToken`, then `onLoginSuccess(data.user, data)`.
- **Delete:**
  - every "simulated" demo button and hardcoded email
  - the `api.studentGoogleLogin` and `api.companyGoogleLogin` calls
  - the "@ipu.ac.in only" copy
- Return `null` when `VITE_GOOGLE_CLIENT_ID` is empty.

### 14.6 `App.jsx` (auth-related blocks only)
- **Initial mode.** `handleAuthSuccess` maps role to mode as follows:

  | role | initial mode |
  |---|---|
  | student | `student` |
  | teacher | `teacher` |
  | tpo, admin | `tpo` |
  | company | `company` |
  | alumni | `alumni` |

  `isModeChosen = role !== "student"`. This also fixes the company user who used to land on WelcomeModeSelect.
- **Allowed modes.** `allowedModes.teacher = ["teacher"]` at minimum. The `TeacherMode` page is owned by the attendance UI.
- **Boot.** When `isAuthenticated`, call `authApi.me()`, then `dispatch(setUserContext(me))` and update `localStorage.user`.
- **Listeners:**
  - `window` event `auth:expired` → `handleLogout({notice})`, where the notice is "This account has been deactivated." for `ACCOUNT_DISABLED`, otherwise "Your session expired. Please sign in again."
  - `useSocketEvent("auth:revoked", …)` → the same handling.
- **Logout.** `handleLogout` first calls `authApi.logout().catch(() => {})`, then:
  1. removes `token`, `isAuthenticated`, `isModeChosen` and `user` (existing)
  2. dispatches `clearAppContext()` and `resetAIChat()` (existing)
  3. calls `ensureSocketAuthentication()` so the socket reconnects as anonymous and leaves the user room
- **Reset route.** Before the auth gate, if `location.pathname` matches `^/reset-password/([A-Za-z0-9]+)/?$`, render `<ResetPasswordScreen token onDone/>`. This applies whether or not the user is signed in.
  - `onDone` calls `history.replaceState({}, "", "/")` and `handleLogout({notice: "Password updated. Sign in with your new password."})`.
  - If the shell adopts react-router, map the route `/reset-password/:token` to the same component.
  - Production hosting needs an SPA rewrite to `index.html`.
- **Forced password change.** If `user?.mustChangePassword`, render `<ChangePasswordModal forced/>` over the shell. It cannot be dismissed; the only alternative is "Sign out".

### 14.7 New components
- **`ResetPasswordScreen.jsx`**:
  - Full-screen card in the AuthScreen style.
  - Calls `checkResetToken` on mount. An invalid token shows an error and a "Request a new link" button that returns to the AuthScreen forgot form.
  - Fields: new password and confirm, at least 8 characters and matching.
  - Submits with `resetPassword`.
- **`ChangePasswordModal.jsx`** (`{user, forced, onClose, onChanged, onSignOut}`):
  - Fields: current password (labelled "Temporary password" when `mustChangePassword`; helper text: "leave empty if you only sign in with Google"), new and confirm.
  - Calls `authApi.changePassword`, then `storeAccessToken(data.accessToken)` and `onChanged(data.user)`. App then dispatches `setUserContext` and updates `localStorage.user`.
- **`ReportIssueModal.jsx`** (`{user, context, onClose}`):
  - A port of Matchy `frontend/src/pages/report-issue-page.jsx` and `services/issue-reports.js` into a modal styled like `card-stark`.
  - Name and email are prefilled and read-only when signed in.
  - Includes a hidden honeypot input `website`.
  - Sends `page` as `context` (for example `${activeMode}/${activeFeature}`).
  - Shows the server message.
- **`tpo/FacultyPanel.jsx`** (`{params}`):
  - **Table:** name, email, department, designation, status badge, courses, last login.
  - **Filters:** search, department (datalist from `collegesApi.mine().departments`), status.
  - **Invite form:** name, email, department, designation, employeeId.
  - **One-time credentials box:** shown when a response contains `temporaryPassword`. It has a Copy button and the copy "Shown only once. The teacher must change it at first sign-in. Expires {date}."
  - **Row actions:** Deactivate or Reactivate, and Reset password.
  - **`params.revealId`:** call `facultyApi.reveal` **once**. Keep a module-level `Set` of consumed IDs, because StrictMode runs effects twice. A 404 shows "already revealed or expired".
  - **`params.highlightId`:** scroll to and highlight that row.
- **`tpo/RecruitersPanel.jsx`**: the same as FacultyPanel, with a company column and a company-name input with a datalist of existing companies from the list.
- **`tpo/IssueReportsPanel.jsx`**:
  - Status tabs with counts.
  - Expandable rows showing the full description.
  - Status select and note, saved through `issueReportsApi.update`.

### 14.8 Modified components
- **`AdminMode.jsx`:**
  - Add three `TPO_TOOLS` tiles:
    - `faculty-management` "Faculty"
    - `recruiter-management` "Recruiters"
    - `issue-reports` "Issue Reports"
  - Add the three render branches, passing `params` from the UI-actions state when present.
  - Add the three IDs to the "known features" list.
- **`ProfileModal.jsx`** becomes role-aware:

  | role | heading | fields |
  |---|---|---|
  | student | (existing) | Existing tabs |
  | teacher | "EDIT FACULTY PROFILE" | name, department, designation; read-only email and employeeId |
  | tpo, admin | (existing) | name, designation |
  | company | (existing) | name, designation; read-only company |

  - The GGSIPU block is shown for `role === "student"` only. Today it is shown for every non-TPO user, including teachers.
  - When `user.ggsipuLinked`:
    - the CGPA and branch inputs are disabled, with the caption "Synced from GGSIPU; re-sync to update"
    - `cgpa` and `branch` are left out of the PATCH body
  - Add a "Change password" button.
- **`SidebarDrawer.jsx`:** add items "Change password" (opens `ChangePasswordModal`) and "Report an issue" (opens `ReportIssueModal`).

---

## 15. GGSIPU decision (gap-audit D15): do not route `studentLogin`. Delete it.

Reasons:
- It invents an email (`firstname.nrollno@ipu.ac.in`) and creates a password-less account without proving ownership of any mailbox.
- Reset emails cannot reach that address.
- It collides with real accounts and gives an E11000 500.
- It makes sign-in depend on an unreliable third-party portal.
- The captcha session is a JWT-gated cookie scoped to `sameSite: strict` and path `/api/v1/ggsipu`.

GGSIPU stays what it already is in the UI: an optional **academic-sync connector**.

Changes:
- `ggsipu.controller.js`:
  - Remove `studentLogin` and its imports of `generateAccessAndRefreshTokens` and `cookieOptions`.
  - Export only `getCaptcha` and `connectGgsipu`.
- `ggsipu.routes.js`: both routes become `verifyJWT, requireRole("student")`. A non-student gets 403 `FORBIDDEN`.
- `connectGgsipu`:
  1. Before updating, check `User.exists({ggsipuEnrollment: nrollno, _id: {$ne: me}})`. A match gives 409 `ENROLLMENT_ALREADY_LINKED` "This GGSIPU enrollment is already linked to another account".
  2. Set `branch = canonicalBranch(stprofile.prgname)`. The raw program name stays in `ggsipuProfile`.
  3. Keep setting `ggsipuLinked: true`, which activates the §6.2 lock.
- The GGSIPU session cookie uses `sameSite` from `AUTH_COOKIE_SAMESITE` and `secure` like the auth cookies. This fixes GG-2.
- Delete `frontend/src/components/StudentGgsipuLogin.jsx`. `GgsipuConnect.jsx` is unchanged and still reads `data.data.user`.

---

## 16. Demo seed (`npm run seed:demo`)

### 16.1 Files and CLI
`backend/package.json` already contains `"seed:demo": "node scripts/seed-demo.js"`. Keep it.

| file | role |
|---|---|
| `backend/scripts/seed-demo.js` | CLI wrapper |
| `backend/scripts/demo/fixtures.js` | Static data (§16.3) |
| `backend/scripts/demo/seed.js` | Exports `parseSeedArgs(argv)`, `resolveDemoPassword(env)`, `seedDemo({password, now = new Date(), log = console.log})` → `{accounts, counts, warnings}`, and `wipeDemo({log})` → `{deleted: {Model: n}}` |

```
npm run seed:demo                          # create or top up the demo dataset (idempotent)
npm run seed:demo -- --reset               # wipe all demo data, then seed again from scratch
npm run seed:demo -- --reset --no-seed     # wipe only
--force                                    # required when NODE_ENV=production; otherwise refuse (exit 1)
```

CLI steps:
1. Run the production guard.
2. Call `DBConnect()` (`src/db/db.js`, which masks credentials).
3. Run `await import("../src/modules/index.js")`. This registers every module's models without starting jobs.
4. Call `init()` on every model in `mongoose.models` to build indexes.
5. If `--reset`, run `wipeDemo`.
6. Unless `--no-seed`, run `seedDemo`.
7. Print the summary (§16.6).
8. Call `mongoose.disconnect()` and exit 0. On error, print the message and exit 1.

**Password:**
- Use `DEMO_PASSWORD` when it is set. If it is shorter than 8 characters, exit 1 with an explanation.
- Otherwise generate `Demo-${crypto.randomBytes(6).toString("base64url")}`.
- Hash it **once** with `bcrypt.hash(pw, 10)`. Every demo account gets `$set: {password: hash}` on **every** run, so the printed password always works. This includes the TPO.
- Print it only in the final summary. `seedDemo` must not log it. Never store it in plain text.

**Model access:**
- Use `const M = (name) => mongoose.models[name] || null`.
- If a model is missing, skip that section and record a warning such as `skip: Application not registered`. The seed therefore works whatever order the modules are implemented in.
- Write straight to the models, except notifications, which go through `notify(..., {email: false, push: false})`.
- The seed computes denormalised fields itself: session `stats`, and an application's status history if PLACEMENTS defines one.
- Use luxon in `APP_TIMEZONE` for all wall-clock times.

**Idempotency (natural keys):**
- Most fields are written with `$setOnInsert`, so changes made during a demo (an accepted offer, attendance marked live) survive a re-run. Use `--reset` to restore everything.
- Demo **users** get `$set: {password, isActive: true, mustChangePassword: false, role, college, collegeName}` on every run.

| entity | key |
|---|---|
| College | `domain: "demo.edu"` (`$set` name, branches, departments, tpo) |
| User | `email` |
| SIH `Student` doc | via `linkStudentToCollege` |
| AlumniProfile | `user` |
| Course | `{teacher, code, section, academicYear}` (`students` via `$addToSet`) |
| ClassSession | `{course, startsAt}` (non-cancelled) |
| AttendanceRecord | `{session, student}` |
| Drive (`Job`) | `{createdBy: tpo, title, company}` |
| Application | `{job, student}` |
| Offer | `{application}` |
| TrainingProgram | `{title, createdBy}` |
| TrainingEnrollment | `{program, student}` |
| IssueReport | `{email, description}` |
| Notification | `dedupeKey: "demo:<key>"` |

### 16.2 Identity data
- **College:** "Demo Institute of Technology", domain `demo.edu`, `branches: ["CSE", "IT"]`, `departments: ["CSE", "IT", "Training & Placement"]`, `tpo` set to the demo TPO.
- **Demo TPO email:** `TPO_EMAIL` when it ends with `@demo.edu`, otherwise `tpo@demo.edu`. If the fallback is used, print a note.
  - Name "Dr. Kavita Rao" (on insert), designation "Training & Placement Officer".
  - All demo accounts use `@demo.edu`, which is how `wipeDemo` finds them.
- **Teachers:**
  - `anita.sharma@demo.edu`: Dr. Anita Sharma, department CSE, Associate Professor, `DIT-F-104`
  - `rahul.verma@demo.edu`: Prof. Rahul Verma, department IT, Assistant Professor, `DIT-F-117`
- **Alumni** (AlumniProfile with `isDemo: true`, `onboardingComplete: true`, `acceptingRequests: true`, `capacity: 3`, college set to the demo college):
  - `nisha.kapoor@demo.edu`: Microsoft, SDE II, 2022, CSE
  - `rohan.mehra@demo.edu`: Razorpay, Backend Engineer, 2023, IT
- **Students:** 30, all with:
  - `passingYear: "2027"`, `semester: 7`, `collegeName`, `college`
  - `rollNumber` in the form `DIT27{BRANCH}{SECTION}{NN}`, for example `DIT27CSEA01`
  - `ggsipuLinked: false`
  - `skills` and one project from their persona
  - empty `socialLinks` (never invent URLs)
  - `linkStudentToCollege` called for each
  - Email is `firstname.lastname@demo.edu` in lowercase.

| section | student (cgpa, attendance target, persona) |
|---|---|
| CSE-A | Aarav Gupta (9.12, .94, M) ★accepted offer · Diya Mehta (8.65, .88, W) ★pending offer · Kabir Singh (6.40, .62, J) ★low attendance · Ananya Iyer (8.90, .91, D) · Vihaan Reddy (7.35, .80, C) · Ishita Bansal (8.10, .86, W) · Arjun Nair (7.05, .71, J) · Meera Joshi (9.40, .97, M) |
| CSE-B | Rohan Malhotra (7.80, .84, C) · Sneha Kulkarni (8.45, .90, D) · Aditya Rao (6.90, .66, W) · Kavya Menon (9.05, .93, J) · Siddharth Jain (7.60, .78, C) · Pooja Yadav (8.20, .87, M) · Nikhil Chauhan (6.75, .74, S) |
| IT-A | Riya Kapoor (7.80, .72, W) · Yash Agarwal (8.35, .89, W) · Tanvi Deshpande (8.75, .92, D) · Harsh Vardhan (7.15, .79, C) · Neha Pillai (8.95, .95, M) · Aryan Sethi (6.55, .64, J) · Simran Gill (7.90, .85, S) · Varun Bhatia (7.45, .81, W) |
| IT-B | Aditi Saxena (8.60, .90, S) · Karan Thakur (6.85, .68, C) · Shreya Ghosh (9.20, .96, D) · Manav Arora (7.70, .83, J) · Anjali Verma (8.05, .87, W) · Dev Patel (7.25, .77, S) · Zoya Khan (8.80, .92, M) |

**Personas** (skills, then the project):
- **W:** JavaScript, React, Node.js, MongoDB, REST APIs. Project: "Event booking web app".
- **D:** Python, SQL, Pandas, Power BI, Statistics. Project: "Sales analytics dashboard".
- **M:** Python, scikit-learn, PyTorch, NLP, Data Structures. Project: "Resume screening with NLP".
- **C:** Linux, Docker, AWS, Kubernetes, CI/CD. Project: "CI/CD pipeline for a microservice".
- **J:** Java, Data Structures, Algorithms, OOP, DBMS. Project: "Library management system".
- **S:** Networking, Linux, Python, Cryptography, Wireshark. Project: "Network intrusion detection lab".

**If the User schema has `activeBacklogs`** (PLACEMENTS):
- Kabir and Aryan: 1
- Karan: 2
- everyone else: 0

### 16.3 Attendance (ATTENDANCE.md models `Course`, `ClassSession`, `AttendanceRecord`)

**Courses.** All courses share these settings:
- `semester: 7`, `passingYear: "2027"`, `academicYear: "2026-27"`
- default `settings` (min 75%)
- `students` = every student in that branch and section
- `joinCode`: 6 characters from `[A-HJ-NP-Z2-9]`, derived deterministically from a hash of the code. On a collision, use a random code.

| code | name | teacher | branch-section | timetable (`day`: 0 = Sun) and room |
|---|---|---|---|---|
| CS701 | Machine Learning | Anita | CSE-A | Mon 10:00, Wed 10:00, Fri 11:00 (60 min), LT-1 |
| CS703 | Cloud Computing | Anita | CSE-B | Tue 11:00, Thu 11:00 (60 min), LT-2 |
| IT701 | Web Engineering | Rahul | IT-A | Mon 14:00, Wed 14:00 (60 min), Lab-3 |
| IT705 | Information Security | Rahul | IT-B | Tue 15:00, Fri 15:00 (60 min), LT-4 |

Each course has 8–12 realistic topics, used in order.

**Past sessions** (the last 28 days, following the timetable, plus any past demo session still `scheduled`):
- `status: "ended"`, `source: "timetable"`
- `liveStartedAt = startsAt + 1 min`, `endedAt = endsAt`
- `qr: {version: 1–40, nonce: random, issuedAt, expiresAt: endedAt}`

**Records, made deterministic per student and course:**
1. Let `held` be the ended sessions.
2. `target = round(rate × held)` attended. Count the attended records that already exist.
3. Among sessions that have no record yet, mark exactly `max(0, min(missing, target − existing))` as attended. Choose them with a seeded shuffle: mulberry32 seeded from `hash(code + email)`.
4. Attended records:
   - `late` when `hash(session + student) < 0.12`, otherwise `present`.
   - 85% use `method: "qr"` with `deviceHash = sha256("demo-device:" + studentId)` and `qrVersion`; the rest use `manual` with `markedBy: teacher`.
   - `markedAt`: present at start + 0–8 min; late at start + `lateAfterMinutes` + 1–15 min.
5. Not attended:
   - `excused` (`manual`, note "Medical leave") when the hash is below 0.1 and the rate is at least 0.8
   - otherwise `absent` with `method: "auto"`
6. Recompute `stats` as status counts plus `enrolled`.

This guarantees at least 7 students below 75% (Kabir, Arjun, Aditya, Nikhil, Riya, Aryan, Karan).

**Upcoming sessions:**
- Scheduled sessions from the timetable for the next 7 days (`source: "timetable"`).
- One **"Live demo class"** per teacher, on their first course:
  - `startsAt = ceil-to-15-min(now + 10 min)`, 60 minutes, `source: "manual"`, `status: "scheduled"`.
  - On a re-run, update the existing future "Live demo class" of that course instead of creating another.
  - If a timetable session already starts at that time, reuse it and set its topic.
  - This lets a teacher press Start immediately, because ATTENDANCE allows starting 30 minutes before `startsAt`.

### 16.4 Placements (PLACEMENTS.md models: `Job` for campus drives, `Application`, `Offer`, `TrainingProgram`, `TrainingEnrollment`; optional `PlacementPolicy`)

Field names follow PLACEMENTS.md. All drives are created by the demo TPO, for the demo college where the schema has `college`, with `graduationYears: ["2027"]` and `employmentType: "Full-time"`. Each has a description paragraph and the selection process "Online test → Technical interview → HR".

| key | company | title | CTC (LPA) | location | min CGPA | max backlogs | branches | skills | deadline / drive (days from now) | status |
|---|---|---|---|---|---|---|---|---|---|---|
| msft-swe | Microsoft | Software Engineer (New Grad) | 44 | Hyderabad | 8.0 | 0 | CSE, IT | Data Structures, Algorithms, System Design, C++ | −10 / −5 | closed |
| razorpay-be | Razorpay | Backend Engineer | 24 | Bengaluru | 7.5 | 0 | CSE, IT | Node.js, Go, SQL, Distributed Systems | −2 / +2 | closed |
| infosys-sp | Infosys | Specialist Programmer | 9.5 | Pune | 6.5 | 1 | CSE, IT | Java, Python, SQL, Problem Solving | +10 / +14 | active |
| zomato-da | Zomato | Data Analyst | 14 | Gurugram | 7.0 | 0 | CSE, IT | SQL, Python, Excel, Statistics | +3 / +6 | active |
| deloitte-cyber | Deloitte | Cyber Security Analyst | 8 | Hyderabad | 6.5 | 1 | IT, CSE | Networking, Linux, SIEM, Python | +14 / +20 | active |
| atlassian-gse | Atlassian | Graduate Software Engineer | 52 | Bengaluru | 8.5 | 0 | CSE | Java, Data Structures, System Design | +7 / +12 | active |
| tcs-digital | TCS | Digital Engineer | 7.5 | Pan India | 6.0 | 2 | CSE, IT | Java, SQL, Cloud Basics | +20 / +25 | draft |

**Applications** (21 in total). Map each generic status to the nearest value in the PLACEMENTS enum.

| drive | applicants and status |
|---|---|
| msft-swe | Aarav (selected), Meera (rejected), Kavya (rejected), Shreya (rejected), Neha (rejected) |
| razorpay-be | Diya (offered), Ishita (rejected), Yash (rejected), Anjali (withdrawn) |
| infosys-sp | Kabir, Vihaan, Manav, Dev and Aryan (applied); Rohan Malhotra (shortlisted) |
| zomato-da | Ananya (shortlisted), Sneha (interview), Tanvi (applied) |
| deloitte-cyber | Aditi (shortlisted), Simran (applied) |
| atlassian-gse | Kavya (applied) |

**Offers:**
- Aarav, Microsoft: 44 LPA, "Software Engineer", joining 2027-07-15, **accepted** 3 days ago.
- Diya, Razorpay: 24 LPA, "Backend Engineer", joining 2027-07-01, **pending**, expires in 5 days.

**Training programs.** Every program has a non-empty `schedule` (TrainingHub reads `schedule[0]`).

| program | delivery and trainer | schedule | enrolments |
|---|---|---|---|
| "Aptitude & Reasoning Bootcamp" | online, Placement Cell | 4 sessions: next Mon, Wed, Fri and Sat, 16:00–17:30 | 14 students |
| "DSA Interview Sprint" | offline in LT-1, Dr. Anita Sharma | 6 sessions twice weekly, starting 7 days ago (in progress) | 12 students |
| "Mock Interview Week" | hybrid, alumni mentors | 3 sessions next week | 8 students |

`PlacementPolicy`, if registered: upsert the demo college's 2027 policy with PLACEMENTS defaults.

**External jobs:** call the job-feed module's exported idempotent sample seeder (JOB-FEED.md, expected name `seedSampleJobs()`). If it is absent, record a warning.

### 16.5 Notifications and issue reports
Notifications use `notify()` with `dedupeKey: "demo:<key>"`:

| recipients | type | title | `ui` | priority |
|---|---|---|---|---|
| All 30 students | `placement.drive.new` | "New drive: Atlassian, Graduate Software Engineer" | `{panel: "jobs.detail", params: {jobId}}` | normal |
| All 30 students | `training.new` | "New training: Mock Interview Week" | `{panel: "training"}` | normal |
| Aarav | `placement.offer.updated` | "Offer accepted: Microsoft" | `{panel: "offers"}` | normal |
| Diya | `placement.offer.new` | "New offer from Razorpay: 24 LPA" | `{panel: "offers"}` | high |
| Sneha | `placement.application.status` | "Your Zomato application moved to Interview" | `{panel: "applications"}` | normal |
| Each student below 75% in a course | `attendance.low` | "Your attendance in {code} is {p}%", with body "Attend the next {n} classes to reach 75%." | `{panel: "attendance.student"}` | normal |
| Each teacher | `system` | "{k} students in {code} are below 75%" | `{panel: "teacher.analytics", params: {courseId}}` | normal |

Issue reports: two, from demo students:
- "QR scanner asks for camera permission twice on iOS Safari" (`open`, page `attendance.scan`)
- "Resume PDF preview is blank after compiling" (`in_progress`, note "Reproduced, fixing")

### 16.6 `wipeDemo` (dependency order; filters only by demo IDs)

**Collect the demo IDs:**
1. `college = College.findOne({domain: "demo.edu"})`.
2. `userIds` = users whose email matches `/@demo\.edu$/i`, or whose `college` is the demo college.
3. `courseIds = Course.find({teacher: {$in: userIds}})`.
4. `jobIds` = `Job` documents with `createdBy ∈ userIds` (or `college` = the demo college).

**Helper:** `deleteWhereAnyRef(modelName, candidatePaths, ids)` builds an `$or` from only those candidate paths that exist in the schema (`model.schema.path(p)`). If none exist, it skips the model with a warning.

**Delete in this order:**

| model | filter |
|---|---|
| `AttendanceRecord` | `course ∈ courseIds` |
| `ClassSession` | `course ∈ courseIds` |
| `Course` | `_id ∈ courseIds` |
| `Offer`, `Application`, `TrainingEnrollment` | `deleteWhereAnyRef` with paths [student, user, applicant, owner] over `userIds`, then [job, drive, program, application] over the demo job, program and application IDs |
| `Job` | `jobIds` |
| `TrainingProgram`, `PlacementPolicy` | `createdBy ∈ userIds` or `college` = demo college |
| `Notification`, `PushSubscription`, `AgentToolCall`, `AuthSession` | `user ∈ userIds` |
| `Resume` | `owner ∈ userIds` |
| `Interview`, `AlumniConnection`, `MentorshipMessage` | Any of [student, user, owner, sender, alumniUser] ∈ `userIds` |
| `AlumniProfile` | `user ∈ userIds` |
| `IssueReport` | `user ∈ userIds`, or email matches `/@demo\.edu$/i` |
| SIH `Student` | Email matches `/@demo\.edu$/i` |
| `User` | `_id ∈ userIds` |
| `College` | The demo college |

Then call the job-feed's `removeSampleJobs?.()` if it is exported.

Data that is not demo data is never touched. In particular, `Company` documents are kept because they are shared reference data.

**Summary output** (stdout, CLI only):
```
Matchy Campus demo data: Demo Institute of Technology (demo.edu)
Database: <host>/<db>
Password for ALL demo accounts: <password>   (shown once; set DEMO_PASSWORD to choose your own)

Role     Email                       Notes
TPO      tpo@demo.edu                College TPO
Teacher  anita.sharma@demo.edu       CS701 (CSE-A), CS703 (CSE-B); live demo class today 14:15
Teacher  rahul.verma@demo.edu        IT701 (IT-A), IT705 (IT-B); live demo class today 14:15
Alumni   nisha.kapoor@demo.edu       Microsoft
Student  aarav.gupta@demo.edu        CSE-A · CGPA 9.12 · attendance 94% · offer accepted (Microsoft)
Student  diya.mehta@demo.edu         CSE-A · CGPA 8.65 · attendance 88% · offer pending (Razorpay)
Student  kabir.singh@demo.edu        CSE-A · CGPA 6.40 · attendance 62% (below 75%)
… (all 30 students)
Counts: users 35 · courses 4 · sessions N (ended / upcoming) · records N · drives 7 · applications 21 · offers 2 · training 3 · notifications N · external jobs N
Warnings: …   (skipped sections, if any)
```

---

## 17. Acceptance tests (`npm test`, which runs `node --test` with `backend/test/helpers.js`)

Every test file:
- imports `./helpers.js` first
- sets the env it relies on **before** the first `getApp()`, because `config.js` reads env on import and dotenv never overrides keys that are already set: `TPO_EMAIL="tpo@demo.edu"`, `TPO_INITIAL_PASSWORD="Init-Pass-123"`, `TEACHER_EMAILS="new.teacher@demo.edu,far.teacher@unknown.org"`, `CLIENT_ID=""` (or `"test-client"` in the Google file)
- creates `College {domain: "demo.edu"}` in `before()`

Mail and Google are stubbed by assigning `accountMailer.send` / `accountMailer.isConfigured` and `googleIdentity.verifyIdToken` / `googleIdentity.isConfigured`. Restore them in `afterEach`.

### `auth.test.js`
1. **New student on demo.edu**
   - 201 with `role === "student"`, `isNewUser === true`, `accessToken` present and `refreshToken === undefined` in `data`.
   - `set-cookie` has `refreshToken=…; Path=/api/v1/auth; HttpOnly`.
   - `user.college` and `user.collegeName` are set, and a SIH `Student` document exists.
2. **Unknown domain** → 400 `INVALID_DOMAIN`, and no user is created.
3. **Stored role wins:**
   - A teacher created with `createUser({role: "teacher"})` logs in with `role: "student"` → 200, `user.role === "teacher"`, `roleAdjusted === true`.
   - A second TPO for the same college logs in → 200 (no slot 409).
4. **TEACHER_EMAILS:**
   - `new.teacher@demo.edu` registers with role `student` → 201 teacher.
   - `far.teacher@unknown.org` → 400 `INVALID_DOMAIN`.
5. **Requested roles for new accounts:**
   - `teacher` (not allow-listed) → 403 `TEACHER_INVITE_REQUIRED`
   - `company` → 403 `RECRUITER_INVITE_REQUIRED`
   - `admin` → 403 `ROLE_NOT_ALLOWED`
   - `tpo` with another email → 403 `TPO_NOT_APPROVED`
6. **TPO bootstrap:**
   - `TPO_EMAIL` with the right password → 201 tpo, and `College.tpo` equals the user.
   - Wrong password → 403 `TPO_NOT_APPROVED`.
   - `TPO_EMAIL` with `role: "student"` and a different password → 403 `TPO_NOT_APPROVED` (reserved email).
7. **Credentials:**
   - Wrong password → 401 `INVALID_CREDENTIALS`.
   - A 7-character password on registration → 400 `WEAK_PASSWORD`.
   - A Google-only account using password login → 400 `PASSWORD_NOT_SET`.
8. **Deactivated user:**
   - Login with the correct password → 403 `ACCOUNT_DISABLED`.
   - The old access token on `/auth/me` → 401 `ACCOUNT_DISABLED`.
   - The old refresh cookie → 403 `ACCOUNT_DISABLED`.
9. **Sessions:**
   - Refresh with the cookie → 200 with a new working `accessToken`.
   - Log in twice, log out session A → A's refresh gives 401 `REFRESH_TOKEN_INVALID` while B still refreshes.
   - `/logout` works without an access token.
   - The 11th login revokes the oldest session (`session_limit`).
10. **`/logout-all`** → every refresh fails, and the old access token gives 401 `SESSION_REVOKED`.
11. **Forgot password:**
    - Mailer not configured → 503 `EMAIL_NOT_CONFIGURED`.
    - With the stub: an existing user → 200, exactly one mail to them whose text contains `${FRONTEND_URL}/reset-password/` followed by a 64-hex token. The database holds only the sha256 of that token, and a `console` spy shows that no line contains it.
    - An unknown email → 200 with no mail.
12. **Reset password:**
    - GET with a valid token → `{valid: true}`. GET with an invalid token → 400 `RESET_TOKEN_INVALID`.
    - POST → 200. Afterwards:
      - the old password fails and the new one works
      - refreshing with an old session gives 401
      - the old access token gives 401 `SESSION_REVOKED`
      - a second POST gives 400 `RESET_TOKEN_INVALID`
      - a security notification exists when the Notification model is registered
    - An expired token → 400.
13. **Change password:**
    - Wrong current password → 400 `INVALID_CURRENT_PASSWORD`.
    - Success:
      - returns an `accessToken` that works
      - the pre-change access token gives 401 `SESSION_REVOKED`
      - the current cookie session still refreshes
      - `mustChangePassword` is false
14. **No secrets:**
    - The `GET` and `PATCH /auth/me` and login JSON never contain `password`, `refreshToken`, `passwordResetToken`, `tokenVersion` or `llmCredentials`.
    - A `verifyJWT` call with a cookie token and a different Bearer token uses the Bearer token.
15. **Profile lock:**
    - A student with `ggsipuLinked: true, cgpa: 8.1, branch: "CSE"` sends PATCH `{cgpa: 9.9, branch: "IT", skills: ["Go"]}` → 200 with cgpa 8.1, branch CSE, skills `["Go"]`, and a message that mentions GGSIPU.
    - An unlinked student: `cgpa` updates, and `cgpa: 11` → 400 `VALIDATION`.
    - `{role: "tpo", email: "x@y.z", isActive: false}` alone → 400 `VALIDATION` and nothing changes.
    - A teacher's `department: "computer science"` is stored as `CSE`, and a teacher's `cgpa` is ignored.
16. **Temporary password:** a teacher with `mustChangePassword` and an expired `tempPasswordExpiresAt` → 401 `TEMP_PASSWORD_EXPIRED`.
17. **Rate limits** (`ENABLE_RATE_LIMIT_IN_TESTS=true`):
    - The 11th login for the same email in the window → 429 `TOO_MANY_ATTEMPTS`.
    - The 4th forgot-password for the same email → 429.
18. **Sockets:**
    - A deactivated user's token connects as anonymous, and a `query` gets `auth:required`.
    - Deactivating a connected user → the client receives `auth:revoked {reason: "deactivated"}`, then a disconnect.
19. **`/auth/options`:** lists `demo.edu`. `google.enabled` is false when `CLIENT_ID` is empty. `passwordReset.emailEnabled` follows the stub.
20. **GGSIPU:** `/ggsipu/captcha` as a teacher → 403 `FORBIDDEN`.

### `auth-google.test.js` (`CLIENT_ID="test-client"`)
1. `googleIdentity.isConfigured = () => false` → 503 `GOOGLE_NOT_CONFIGURED`.
2. `verifyIdToken` throws, and the body also carries `{email: "victim@demo.edu"}` → 401 `GOOGLE_TOKEN_INVALID`, and **no user exists** with that email.
3. `email_verified: false` → 403 `EMAIL_NOT_VERIFIED`.
4. A new verified `x@demo.edu` → 201 student with `authProvider: "google"` and `googleId === sub`.
5. A verified `TEACHER_EMAILS` address → 201 teacher.
6. A new `x@gmail.com` with `role: "alumni"` → 201 alumni. The same address as a student → 400 `INVALID_DOMAIN`.
7. An existing local user with the same email → 200, `googleId` linked, stored role kept.
8. An existing user with a different `googleId` → 403 `GOOGLE_ACCOUNT_MISMATCH`.
9. A deactivated user → 403 `ACCOUNT_DISABLED`.
10. `GOOGLE_REQUIRE_HOSTED_DOMAIN=true` and no `hd` → 403 `HOSTED_DOMAIN_REQUIRED`.

### `faculty.test.js`
1. **Invite, mailer off:** the TPO invites → 201 `delivery: "manual"` with a `temporaryPassword` of at least 12 characters.
   - The teacher logs in with it and gets `mustChangePassword: true`.
   - `GET /faculty/:id` and the list never include the password.
   - The stored hash is not equal to the temporary password.
2. **Invite, mailer stubbed:**
   - `delivery: "email"` and no password in the response. The captured mail contains the password and `FRONTEND_URL`.
   - When the stub throws: `delivery: "manual"`, plus `temporaryPassword` and `emailError`.
3. **Create conflicts:**
   - A duplicate email → 409 `EMAIL_EXISTS` with `existingRole`.
   - Inviting `TPO_EMAIL` → 409 `EMAIL_RESERVED`.
   - Bad input → 400 `VALIDATION` with `field`.
4. **Permissions:**
   - A student or teacher calling `POST /faculty` → 403 `FORBIDDEN`.
   - An admin without a college and without `collegeId` → 400 `COLLEGE_REQUIRED`.
   - An admin with `collegeId` → 201.
5. **Scope:** a TPO of college B calling GET, PATCH or DELETE on a college-A teacher → 404 `NOT_FOUND`.
6. **Deactivate and reactivate:**
   - After `DELETE`: login gives 403 `ACCOUNT_DISABLED`, and the old token gives 401.
   - After `PATCH {isActive: true}`: login works.
   - Reset on an inactive teacher → 409 `ACCOUNT_INACTIVE`.
7. **Reset password:** the new temporary password works, the old one fails, and sessions are revoked.
8. **List:** `search`, `department` (canonicalised), `status` and pagination work, and `total` is correct.
9. **Recruiters:**
   - Two invites with "Acme Corp" and "acme corp" create one `Company`, and each recruiter has `role: "company"` with `company` set.
   - Missing both `companyName` and `companyId` → 400.
10. **Tools** (call `tool.preview` and `tool.handler` directly with `ctx = {user: tpo, role: "tpo"}`):
    - `faculty_list` returns `ui.panel === "tpo.faculty"`.
    - `faculty_invite.preview` creates no user and throws `EMAIL_EXISTS` for an existing email.
    - The `faculty_invite` handler creates the user, and `JSON.stringify(result)` does not contain the temporary password.
    - With the mailer off, `ui.params.revealId` is set:
      - `POST /faculty/reveal` as the same TPO returns the password once; a second call gives 404 `REVEAL_EXPIRED`.
      - Another TPO gets 404, and the owner can still redeem it.
    - If `/api/v1/agent-tools/manifest` exists (agent-tools implemented), a student's manifest does not list `faculty_invite`.
11. **Colleges:**
    - A TPO's `PATCH /colleges/mine {branches: ["computer science", "IT", "cse"]}` stores `["CSE", "IT"]`.
    - `GET /colleges/mine` as a student → 200.
    - `POST /colleges` as a TPO → 403.

### `issue-reports.test.js`
1. An anonymous valid report → 201 `{id}`. It is stored with `status: "open"` and `user: null`.
2. Missing description, a bad email, or a 5001-character description → 400 `VALIDATION`, never 500.
3. **Authenticated report** with body `{description}` only:
   - name, email, user, role and college are taken from the account
   - spoofed `email` in the body is ignored
   - the college TPO receives an `issue.new` notification when the Notification model is registered
4. A non-empty honeypot `website` → 201 and nothing stored.
5. **Listing:**
   - `GET` as a student → 403.
   - A TPO sees their college's reports plus anonymous ones, but not another college's.
   - An admin sees all.
   - `counts` are correct.
6. `PATCH {status: "resolved", note}` sets `resolvedAt` and `handledBy` and notifies the reporting user.
7. With rate limits enabled, the 11th POST from one IP in 10 minutes → 429.
8. The `issue_report_create` handler creates a report with the `ctx.user` identity.

### `seed-demo.test.js` (calls `seedDemo` and `wipeDemo` against the test DB; `accountMailer.send` is stubbed to throw)
1. **First run** (`seedDemo({password: "DemoPass#2026", now: fixed})`):
   - 35 users with `@demo.edu`: 1 TPO, 2 teachers, 2 alumni and 30 students.
   - `College.tpo` is set.
   - A student and a teacher can log in with the password through the API.
   - No mail is sent, and the captured `log` lines never contain the password.
2. **Second run with the same `now`:** every count is identical (users, courses, sessions, records, drives, applications, offers, programs, enrolments, alumni profiles, notifications).
3. **When the Course model is registered:**
   - 4 courses exist, and each ended session's `stats` equal the record counts.
   - At least 3 students are below 75% in at least one course, computed from the records.
   - At least one future `scheduled` session exists per course.
   - Each teacher has one "Live demo class" starting within 30 minutes.
   - A re-run with `now + 3 days` adds new ended sessions with no duplicate `{course, startsAt}`.
4. **When the placements models are registered:**
   - At least 6 drives.
   - At least 4 distinct application statuses.
   - One pending offer and one accepted offer.
   - 3 training programs, each with a non-empty schedule.
5. **`wipeDemo`:**
   - Zero `@demo.edu` users, no demo college, no courses for the demo teachers, and no notifications for demo users.
   - A user on `other.edu` (and their data) created before the seed is untouched.
6. **CLI helpers:**
   - `parseSeedArgs(["--reset", "--no-seed"])` returns `{reset: true, seed: false, force: false}`.
   - The production guard refuses without `--force`.
   - `resolveDemoPassword({DEMO_PASSWORD: "short"})` throws.

### Manual frontend checks (`npm run build` and `npm run lint` must pass)
1. A demo.edu student signs in from AuthScreen. There is no `@ipu.ac.in` block.
2. The Google button appears only when `VITE_GOOGLE_CLIENT_ID` is set, and sign-in works.
3. The emailed reset link opens `ResetPasswordScreen`.
4. The invited teacher is forced to change the password.
5. Logout calls the API, and a later refresh fails.
6. A deactivated user is signed out with a notice.
7. The Faculty, Recruiters and Issue Reports tiles work in TPO mode.
8. "Report an issue" works both signed out and signed in.

---

## 18. Cross-area dependencies and out of scope

**This area relies on:**
- NOTIFICATIONS `notify()` at `backend/src/modules/notifications/notify.js`.
- ATTENDANCE model names `Course`, `ClassSession` and `AttendanceRecord`.
- PLACEMENTS model names `Job`, `Application`, `Offer`, `TrainingProgram`, `TrainingEnrollment` and optionally `PlacementPolicy`:
  - user-reference paths among student, user, applicant, owner and createdBy
  - job-reference paths among job and drive
  - `Application` must not require a resume
- The JOB-FEED sample seeder `seedSampleJobs()` (and optionally `removeSampleJobs()`).
- The AGENT-TOOLS registry (preview errors mapped the same way as handler errors).

**Other areas must:**
- **Agent-tools:** reject users with `isActive === false`.
- **UI-actions:** register the panels `tpo.faculty`, `tpo.recruiters` and `tpo.issues`, mapping them to the TPO mode tiles.
- **Python orchestrator:** stop collapsing roles. Today `orchestrator.py:394-398` turns every role other than `tpo` into `student`.
- **Attendance and placements:** compare branches through `canonicalBranch()`.
- **Infrastructure:** set `app.set("trust proxy", …)` behind a proxy so that per-IP limits see real client IPs.

**Out of scope:**
- Deactivating students
- Changing roles, and supporting more than one TPO per college
- Bulk CSV invites
- Email verification for password self-registration
- Recruiter accounts that work across several colleges
- Mandatory server-side enforcement of `mustChangePassword`. It is enforced by the UI only, backed by the temporary-password expiry.

## 19. Error codes (`errors[0].code`) introduced or used by this area

| code | status | meaning |
|---|---|---|
| `VALIDATION` | 400 | Invalid or missing input |
| `WEAK_PASSWORD` | 400 | Password shorter than 8 or longer than 128 characters |
| `INVALID_DOMAIN` | 400 | The email domain is not a registered college |
| `PASSWORD_NOT_SET` | 400 | Password login on a Google-only account |
| `INVALID_CURRENT_PASSWORD` | 400 | Wrong current password on change-password |
| `RESET_TOKEN_INVALID` | 400 | Reset token missing, expired or already used |
| `COLLEGE_REQUIRED` | 400 | Admin action that needs a college |
| `UNAUTHORIZED` | 401 | Missing or invalid access token |
| `INVALID_CREDENTIALS` | 401 | Wrong email or password |
| `TEMP_PASSWORD_EXPIRED` | 401 | Invite or admin-reset temporary password has expired |
| `SESSION_REVOKED` | 401 | `tokenVersion` mismatch |
| `REFRESH_TOKEN_INVALID` | 401 | Refresh token unknown, revoked or expired |
| `GOOGLE_TOKEN_INVALID` | 401 | Google ID token failed verification |
| `ACCOUNT_DISABLED` | 401 in `verifyJWT`; 403 at login, google and refresh | The account is deactivated |
| `EMAIL_NOT_VERIFIED` | 403 | Google says the email is not verified |
| `HOSTED_DOMAIN_REQUIRED` | 403 | Google `hd` does not match the email domain |
| `GOOGLE_ACCOUNT_MISMATCH` | 403 | The account is linked to a different Google account |
| `TEACHER_INVITE_REQUIRED` | 403 | Teacher registration without an invite or allow-list entry |
| `RECRUITER_INVITE_REQUIRED` | 403 | Recruiter self-registration attempt |
| `ROLE_NOT_ALLOWED` | 403 | Requested role cannot self-register (admin) |
| `TPO_NOT_APPROVED` | 403 | TPO registration not approved |
| `FORBIDDEN` | 403 | Role not allowed for the route |
| `NOT_FOUND` | 404 | Not found, or outside the caller's scope |
| `REVEAL_EXPIRED` | 404 | One-time password already shown or expired |
| `EMAIL_EXISTS` | 409 | A user already has this email |
| `EMAIL_RESERVED` | 409 | The email is `TPO_EMAIL` |
| `TPO_EXISTS` | 409 | The college already has a TPO |
| `NO_COLLEGE` | 409 | The TPO account is not linked to a college |
| `ACCOUNT_INACTIVE` | 409 | Password reset on a deactivated account |
| `ENROLLMENT_ALREADY_LINKED` | 409 | The GGSIPU enrollment belongs to another account |
| `DUPLICATE` | 409 | Existing `app.js` mapping of E11000 |
| `TOO_MANY_ATTEMPTS` | 429 | Rate limit hit |
| `EMAIL_NOT_CONFIGURED` | 503 | SMTP is not configured |
| `GOOGLE_NOT_CONFIGURED` | 503 | `CLIENT_ID` is not set |
| `TPO_BOOTSTRAP_DISABLED` | 503 | TPO bootstrap env vars are not configured |

**Suggested implementation order:**
1. User model changes, `AuthSession` and `auth-session.service`
2. Middleware and socket auth-context
3. The auth controller and routes, including Google and reset
4. The profile service and the GGSIPU changes
5. The faculty module, including colleges and tools
6. Issue reports
7. The frontend
8. The seed
9. Tests alongside each step
