import { Suspense } from "react";
import { Link } from "react-router-dom";
import { Construction } from "lucide-react";
import ErrorBoundary from "../ui/ErrorBoundary.jsx";
import LoadingState from "../ui/LoadingState.jsx";
import { FEATURE_COMPONENTS, FEATURE_LAZY } from "./featurePanels.js";

const CHUNK_ERROR = /dynamically imported module|Importing a module script failed|Loading chunk/i;

function PanelUnavailable({ error, standalone }) {
  const card = (
    <section className="card-stark w-full max-w-md bg-white p-6 text-center">
      <Construction className="mx-auto mb-2 h-8 w-8" aria-hidden="true" />
      <div className="text-xs font-black uppercase">This panel is not available yet</div>
      <p className="mx-auto mt-1 max-w-md text-[11px] font-medium text-gray-600">
        It is still being set up on this server. Try again after the next update, or ask the copilot for help.
      </p>
      {import.meta.env.DEV && error?.message && <p className="mt-2 break-words font-mono text-[10px] text-gray-500">{error.message}</p>}
      {standalone && (
        <Link to="/" className="btn-primary mt-3 min-h-11 px-3 py-1.5 text-xs sm:min-h-0">
          GO TO APP
        </Link>
      )}
    </section>
  );
  if (!standalone) return card;
  return <div className="flex min-h-dvh items-center justify-center p-4">{card}</div>;
}

function PanelCrashed({ error, reset }) {
  const chunkFailure = CHUNK_ERROR.test(String(error?.message ?? ""));
  return (
    <section role="alert" className="card-stark border-2 border-black bg-red-50 p-5 text-center">
      <div className="text-xs font-black uppercase">{chunkFailure ? "A NEW VERSION IS AVAILABLE" : "THIS PANEL CRASHED"}</div>
      <p className="mx-auto mt-1 max-w-md break-words text-[11px] font-semibold text-gray-700">
        {chunkFailure ? "This part of the app was updated. Reload to continue." : error?.message || "Something went wrong."}
      </p>
      <button
        type="button"
        onClick={chunkFailure ? () => window.location.reload() : reset}
        className="btn-primary mt-3 min-h-11 px-3 py-1.5 text-xs sm:min-h-0"
      >
        {chunkFailure ? "RELOAD APP" : "RELOAD PANEL"}
      </button>
    </section>
  );
}

/**
 * Renders a feature component owned by another role (see featurePanels.js)
 * inside its own error boundary + suspense, so a missing or crashing module
 * only affects this slot. `standalone` = full-page route (centred fallback with a link home).
 */
export default function FeatureSlot({ name, resetKey, standalone = false, fallbackLabel = "LOADING PANEL…", ...props }) {
  const Component = FEATURE_LAZY[name];
  if (!Component || !FEATURE_COMPONENTS[name]) return <PanelUnavailable error={{ message: `Unknown feature ${name}` }} standalone={standalone} />;
  const loader = <LoadingState label={fallbackLabel} />;
  return (
    <ErrorBoundary
      resetKey={resetKey ?? name}
      fallback={(error, reset) =>
        error?.name === "PanelUnavailableError" ? <PanelUnavailable error={error} standalone={standalone} /> : <PanelCrashed error={error} reset={reset} />
      }
    >
      <Suspense fallback={standalone ? <div className="flex min-h-dvh items-center justify-center">{loader}</div> : loader}>
        <Component {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}
