import { useState } from "react";
import { useDispatch } from "react-redux";
import { Link, useLocation } from "react-router-dom";
import {
  Building2,
  Eye,
  EyeOff,
  Flag,
  GraduationCap,
  Info,
  LoaderCircle,
  Lock,
  LogIn,
  Mail,
  Presentation,
  ShieldCheck,
  TriangleAlert,
  Users,
} from "lucide-react";
import GoogleAuthButton from "./GoogleAuthButton.jsx";
import ForgotPasswordForm from "../features/auth/ForgotPasswordForm.jsx";
import { completeLogin } from "../features/auth/session.js";
import { DEFAULT_AUTH_OPTIONS, getAuthOptions, loginOrRegister } from "../lib/api/auth.js";
import { APP_INITIALS, APP_NAME, GOOGLE_CLIENT_ID } from "../lib/config.js";
import { errorMessage } from "../lib/http.js";
import { toastInfo } from "../ui/toast.js";
import { useAsync } from "../ui/useAsync.js";
import { roleLabel } from "../workspace/modes.js";

const ROLE_TABS = [
  { id: "student", label: "Student", icon: GraduationCap },
  { id: "teacher", label: "Faculty", icon: Presentation },
  { id: "tpo", label: "TPO", icon: ShieldCheck },
  { id: "alumni", label: "Alumni", icon: Users },
  { id: "company", label: "Recruiter", icon: Building2 },
];

const EMAIL_LABEL = {
  student: "College email address",
  teacher: "Faculty email address",
  tpo: "Approved TPO email",
  alumni: "Alumni email address",
  company: "Recruiter email address",
};

const PLACEHOLDER = {
  student: "you@college.edu",
  teacher: "you@college.edu",
  tpo: "tpo@college.edu",
  alumni: "you@example.com",
  company: "you@company.com",
};

const FOOTER = {
  student: "New student emails register automatically (your college domain must be registered).",
  teacher: "Faculty accounts are created by your TPO — use the invite email to set your password.",
  tpo: "First use registers the approved TPO • Later uses sign in to the same account",
  alumni: "First use creates an unverified alumni profile • Verification will be added later",
  company: "Recruiter accounts are created by the placement cell.",
};

const FRIENDLY_ERRORS = {
  ACCOUNT_DISABLED: "This account has been deactivated. Contact your placement office.",
  TEACHER_INVITE_REQUIRED: "Faculty accounts are created by your placement office. Ask your TPO to invite you.",
  RECRUITER_INVITE_REQUIRED: "Recruiter accounts are created by the placement office.",
  TEMP_PASSWORD_EXPIRED: "Your temporary password has expired. Ask your placement office for a new invite.",
  TOO_MANY_ATTEMPTS: "Too many attempts. Wait a minute and try again.",
  INVALID_CREDENTIALS: "Incorrect email or password.",
  PASSWORD_NOT_SET: "This account signs in with Google. Use Continue with Google, or Forgot password to set a password.",
  WEAK_PASSWORD: "Use a password with at least 8 characters.",
  EMAIL_NOT_VERIFIED: "Your Google email is not verified.",
  GOOGLE_NOT_CONFIGURED: "Google sign-in is not enabled on this server.",
};

const LEGACY_MISMATCH = /registered as an? (student|teacher|faculty|tpo|admin|company|recruiter|alumni) account/i;
const ROLE_ALIAS = { faculty: "teacher", recruiter: "company" };

/** → { message, mismatchRole } */
const describeError = (error) => {
  const code = error?.code;
  let mismatchRole = null;
  if (code === "ROLE_MISMATCH") mismatchRole = error?.details?.role ?? null;
  const legacy = typeof error?.message === "string" ? error.message.match(LEGACY_MISMATCH) : null;
  if (!mismatchRole && legacy) mismatchRole = ROLE_ALIAS[legacy[1].toLowerCase()] ?? legacy[1].toLowerCase();
  if (mismatchRole === "admin") mismatchRole = "tpo";
  const message =
    (code && FRIENDLY_ERRORS[code]) ||
    (code === "INVALID_DOMAIN" ? errorMessage(error, "Use an email on your college's registered domain.") : null) ||
    errorMessage(error, "Sign-in failed. Please try again.");
  return { message, mismatchRole: ROLE_TABS.some((tab) => tab.id === mismatchRole) ? mismatchRole : null };
};

/**
 * Sign-in / registration screen (FRONTEND.md §6.3). Used for the whole app and
 * in place by RequireAuth (the URL, e.g. an attendance QR link, is kept).
 */
export default function AuthScreen({ title, subtitle, notice, onAuthSuccess }) {
  const dispatch = useDispatch();
  const location = useLocation();
  const [role, setRole] = useState("student");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState(null); // { message, mismatchRole }
  const [showForgot, setShowForgot] = useState(false);

  const optionsQuery = useAsync(() => getAuthOptions(), []);
  const options = optionsQuery.data ?? DEFAULT_AUTH_OPTIONS;
  const domains = options.collegeDomains.slice(0, 3).map((item) => `@${item.domain}`);
  const showGoogle = Boolean(GOOGLE_CLIENT_ID) && options.google.enabled !== false;
  const resetByEmail = options.passwordReset.emailEnabled !== false;

  const switchRole = (nextRole) => {
    setRole(nextRole);
    setFailure(null);
  };

  const finish = (user, session) => {
    if (session?.roleAdjusted && user?.role && user.role !== role) {
      toastInfo(`Signed in as ${roleLabel(user.role)} — that's how this email is registered.`);
    }
    onAuthSuccess?.(user);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setFailure(null);
    setLoading(true);
    try {
      const session = await loginOrRegister({ email, password, role });
      const user = await dispatch(completeLogin(session));
      finish(user, session);
    } catch (error) {
      setFailure(describeError(error));
      setLoading(false);
    }
  };

  const reportHref = `/report-issue?from=${encodeURIComponent(`${location.pathname}${location.search}`)}`;

  return (
    <div className="flex min-h-dvh items-center justify-center bg-[#f8fafc] p-4 text-black">
      <div className="card-stark w-full max-w-md space-y-5 border-2 border-black p-5 shadow-bold-lg sm:p-6">
        <div className="space-y-1.5 border-b-2 border-black pb-4 text-center">
          <div className="mb-1 inline-block border-2 border-black bg-black px-3 py-1 text-2xl font-black text-white">{APP_INITIALS}</div>
          <h1 className="text-xl font-extrabold uppercase tracking-tight">{title || APP_NAME}</h1>
          <p className="text-xs font-semibold text-gray-600">{subtitle || "Placements · Attendance · Careers"}</p>
        </div>

        {notice && (
          <div role="status" className="flex items-start gap-2 border-2 border-black bg-blue-50 p-3 text-xs font-bold">
            <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{notice}</span>
          </div>
        )}

        {failure && (
          <div role="alert" className="animate-fadeIn space-y-2 border-2 border-black bg-red-100 p-3 text-xs font-bold">
            <div className="flex items-start gap-2">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-700" aria-hidden="true" />
              <span>{failure.message}</span>
            </div>
            {failure.mismatchRole && failure.mismatchRole !== role && (
              <button type="button" onClick={() => switchRole(failure.mismatchRole)} className="btn-primary min-h-11 px-3 py-1.5 text-xs sm:min-h-0">
                CONTINUE AS {roleLabel(failure.mismatchRole).toUpperCase()}
              </button>
            )}
          </div>
        )}

        <div role="tablist" aria-label="Account type" className="grid grid-cols-3 gap-1 border-2 border-black bg-gray-100 p-1 sm:grid-cols-5">
          {ROLE_TABS.map((tab) => {
            const Icon = tab.icon;
            const selected = role === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => switchRole(tab.id)}
                className={`flex min-h-11 flex-col items-center justify-center gap-1 px-1 py-1.5 text-[10px] font-black uppercase sm:min-h-0 ${selected ? "bg-black text-white" : "text-black hover:bg-gray-200"}`}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {tab.label}
              </button>
            );
          })}
        </div>

        {showForgot ? (
          <ForgotPasswordForm defaultEmail={email} onBack={() => setShowForgot(false)} />
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <label className="block">
              <span className="mb-1 block text-xs font-extrabold uppercase">{EMAIL_LABEL[role]}</span>
              <span className="relative flex items-center">
                <Mail className="pointer-events-none absolute left-3 h-4 w-4 text-gray-500" aria-hidden="true" />
                <input
                  type="email"
                  required
                  autoComplete="email"
                  inputMode="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder={PLACEHOLDER[role]}
                  className="input-stark w-full pl-9 font-mono text-base sm:text-xs"
                />
              </span>
              {role === "student" && domains.length > 0 && (
                <span className="mt-1 block text-[10px] font-semibold text-gray-500">Use your college email ({domains.join(", ")} …)</span>
              )}
              {role === "teacher" && (
                <span className="mt-1 block text-[10px] font-semibold text-gray-500">Use the temporary password from your invite.</span>
              )}
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-extrabold uppercase">Password</span>
              <span className="relative flex items-center">
                <Lock className="pointer-events-none absolute left-3 h-4 w-4 text-gray-500" aria-hidden="true" />
                <input
                  type={showPassword ? "text" : "password"}
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="input-stark w-full pl-9 pr-10 font-mono text-base sm:text-xs"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((value) => !value)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="absolute right-1 flex h-9 w-9 items-center justify-center text-gray-600 hover:text-black"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
                </button>
              </span>
            </label>

            <button type="submit" disabled={loading} className="btn-primary min-h-11 w-full justify-center py-2.5 text-xs font-extrabold tracking-wider disabled:opacity-60">
              {loading ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <LogIn className="h-4 w-4" aria-hidden="true" />}
              <span>CONTINUE AS {roleLabel(role).toUpperCase()}</span>
            </button>

            <div className="text-center">
              {resetByEmail ? (
                <button type="button" onClick={() => setShowForgot(true)} className="text-[11px] font-black uppercase underline underline-offset-2">
                  Forgot password?
                </button>
              ) : (
                <p className="text-[11px] font-semibold text-gray-600">Forgot your password? Ask your placement office (TPO) to reset it.</p>
              )}
            </div>
          </form>
        )}

        {showGoogle && !showForgot && (
          <div className="space-y-3">
            <div className="relative">
              <div className="absolute inset-0 flex items-center" aria-hidden="true">
                <div className="w-full border-t-2 border-black" />
              </div>
              <div className="relative flex justify-center text-[10px] font-black uppercase">
                <span className="bg-white px-2 text-gray-600">OR</span>
              </div>
            </div>
            <GoogleAuthButton role={role} onSuccess={finish} onError={(error) => setFailure(describeError(error))} />
          </div>
        )}

        <div className="space-y-2 border-t border-gray-200 pt-3 text-center text-[10px] font-semibold text-gray-500">
          <p>{FOOTER[role]}</p>
          <Link to={reportHref} className="inline-flex items-center gap-1 font-black uppercase text-black underline underline-offset-2">
            <Flag className="h-3 w-3" aria-hidden="true" /> Report an issue
          </Link>
        </div>
      </div>
    </div>
  );
}
