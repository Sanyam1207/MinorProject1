import { useState } from "react";
import { CheckCircle2, LoaderCircle, Send } from "lucide-react";
import { ISSUE_DESCRIPTION_MAX, submitIssueReport } from "../../lib/api/issueReports.js";
import { errorMessage } from "../../lib/http.js";

/**
 * Issue report form (FRONTEND.md §9.6). When `signedIn`, name/email are shown
 * read-only (the server takes them from the session anyway).
 */
export default function ReportIssueForm({ defaultName = "", defaultEmail = "", defaultDescription = "", pageUrl = "", signedIn = false, onDone }) {
  const [name, setName] = useState(defaultName);
  const [email, setEmail] = useState(defaultEmail);
  const [description, setDescription] = useState(defaultDescription.slice(0, ISSUE_DESCRIPTION_MAX));
  const [website, setWebsite] = useState(""); // honeypot
  const [status, setStatus] = useState("idle"); // idle | sending | sent
  const [error, setError] = useState(null);
  const [serverMessage, setServerMessage] = useState("");

  const submit = async (event) => {
    event.preventDefault();
    if (!description.trim()) return setError("Describe what went wrong.");
    if (!signedIn && (!name.trim() || !email.trim())) return setError("Name and email are required.");
    setStatus("sending");
    setError(null);
    try {
      const result = await submitIssueReport({ name, email, description, pageUrl, website });
      setServerMessage(result.message);
      setStatus("sent");
    } catch (requestError) {
      setStatus("idle");
      setError(
        requestError?.code === "TOO_MANY_ATTEMPTS" || requestError?.status === 429
          ? "Too many reports from this device. Try again later."
          : errorMessage(requestError, "Couldn't send the report. Try again."),
      );
    }
    return undefined;
  };

  if (status === "sent") {
    return (
      <div className="space-y-3 text-center" role="status">
        <CheckCircle2 className="mx-auto h-8 w-8 text-green-700" aria-hidden="true" />
        <p className="text-xs font-bold">{serverMessage}</p>
        {onDone && (
          <button type="button" onClick={onDone} className="btn-primary min-h-11 px-4 py-1.5 text-xs sm:min-h-0">
            DONE
          </button>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs font-extrabold uppercase">Name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            readOnly={signedIn}
            required={!signedIn}
            maxLength={120}
            autoComplete="name"
            className={`input-stark w-full text-base sm:text-xs ${signedIn ? "bg-gray-100" : ""}`}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-extrabold uppercase">Email</span>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            readOnly={signedIn}
            required={!signedIn}
            maxLength={254}
            autoComplete="email"
            className={`input-stark w-full font-mono text-base sm:text-xs ${signedIn ? "bg-gray-100" : ""}`}
          />
        </label>
      </div>
      <label className="block">
        <span className="mb-1 flex items-center justify-between text-xs font-extrabold uppercase">
          What went wrong?
          <span className="font-mono text-[10px] font-bold text-gray-500 tabular-nums">
            {description.length}/{ISSUE_DESCRIPTION_MAX}
          </span>
        </span>
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value.slice(0, ISSUE_DESCRIPTION_MAX))}
          rows={6}
          required
          placeholder="What were you doing, what did you expect, and what happened instead?"
          className="input-stark w-full text-base sm:text-xs"
        />
      </label>
      <label className="sr-only" aria-hidden="true">
        Website
        <input tabIndex={-1} autoComplete="off" value={website} onChange={(event) => setWebsite(event.target.value)} />
      </label>
      {error && (
        <p role="alert" className="border-2 border-black bg-red-100 p-2 text-[11px] font-bold">
          {error}
        </p>
      )}
      <button type="submit" disabled={status === "sending"} className="btn-primary min-h-11 px-4 py-1.5 text-xs disabled:opacity-60 sm:min-h-0">
        {status === "sending" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Send className="h-3.5 w-3.5" aria-hidden="true" />}
        SEND REPORT
      </button>
    </form>
  );
}
