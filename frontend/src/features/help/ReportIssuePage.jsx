import { useSelector } from "react-redux";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowLeft, Flag } from "lucide-react";
import { APP_INITIALS, APP_NAME } from "../../lib/config.js";
import { isSameOriginUrl } from "../../workspace/deepLink.js";
import ReportIssueForm from "./ReportIssueForm.jsx";

/** Public `/report-issue[?from=<url>]` (FRONTEND.md §5), prefilled when signed in. */
export default function ReportIssuePage() {
  const [searchParams] = useSearchParams();
  const status = useSelector((state) => state.session.status);
  const user = useSelector((state) => state.appContext.user);
  const signedIn = status === "authenticated" && Boolean(user);
  const from = searchParams.get("from") || "";
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const pageUrl = from && isSameOriginUrl(from, origin || undefined) ? new URL(from, origin).href : "";

  return (
    <div className="flex min-h-dvh items-start justify-center bg-[#f8fafc] p-4 text-black sm:items-center">
      <div className="card-stark w-full max-w-lg space-y-5 border-2 border-black p-5 shadow-bold-lg sm:p-6">
        <div className="flex items-center justify-between gap-3 border-b-2 border-black pb-3">
          <div className="flex items-center gap-2">
            <span className="border-2 border-black bg-black px-2 py-0.5 text-sm font-black text-white">{APP_INITIALS}</span>
            <div>
              <h1 className="flex items-center gap-1.5 text-sm font-black uppercase">
                <Flag className="h-4 w-4" aria-hidden="true" /> Report an issue
              </h1>
              <p className="text-[10px] font-semibold text-gray-600">{APP_NAME}</p>
            </div>
          </div>
          <Link to="/" className="btn-secondary min-h-11 px-3 py-1.5 text-xs sm:min-h-0">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> OPEN APP
          </Link>
        </div>
        <ReportIssueForm
          key={signedIn ? user?._id || user?.email : "anonymous"}
          defaultName={signedIn ? user?.name || "" : ""}
          defaultEmail={signedIn ? user?.email || "" : ""}
          pageUrl={pageUrl}
          signedIn={signedIn}
        />
      </div>
    </div>
  );
}
