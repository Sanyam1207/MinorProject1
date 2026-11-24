import { useDispatch } from "react-redux";
import { Link } from "react-router-dom";
import { LogOut, ShieldAlert } from "lucide-react";
import AuthScreen from "../../components/AuthScreen.jsx";
import LoadingState from "../../ui/LoadingState.jsx";
import { roleLabel } from "../../workspace/modes.js";
import { logout } from "./session.js";
import { useSession } from "./useSession.js";

const allows = (roles, role) => !roles?.length || roles.includes(role) || (role === "admin" && roles.includes("tpo"));

/**
 * Route guard (FRONTEND.md §5): `checking` → loader; `anonymous` → the sign-in
 * screen IN PLACE (the URL, e.g. `/attend?s=…&t=…`, is kept and the children
 * render right after login); wrong role → an explanation card.
 */
export default function RequireAuth({ roles, title, subtitle, children }) {
  const dispatch = useDispatch();
  const { status, role } = useSession();

  if (status === "checking") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-[#f8fafc]">
        <LoadingState label="CHECKING YOUR SESSION…" />
      </div>
    );
  }
  if (status !== "authenticated") return <AuthScreen title={title} subtitle={subtitle} />;
  if (!allows(roles, role)) {
    const audience = roles.map((value) => roleLabel(value)).join(" / ");
    return (
      <div className="flex min-h-dvh items-center justify-center bg-[#f8fafc] p-4">
        <div className="card-stark w-full max-w-md space-y-4 border-2 border-black p-6 text-center">
          <ShieldAlert className="mx-auto h-8 w-8" aria-hidden="true" />
          <h1 className="text-sm font-black uppercase">Wrong account for this page</h1>
          <p className="text-xs font-semibold text-gray-700">
            This page is for {audience}. You are signed in as {roleLabel(role)}.
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <Link to="/" className="btn-primary min-h-11 px-3 py-1.5 text-xs sm:min-h-0">
              GO TO APP
            </Link>
            <button type="button" onClick={() => dispatch(logout())} className="btn-secondary min-h-11 px-3 py-1.5 text-xs sm:min-h-0">
              <LogOut className="h-3.5 w-3.5" aria-hidden="true" /> SIGN IN AS SOMEONE ELSE
            </button>
          </div>
        </div>
      </div>
    );
  }
  return children;
}
