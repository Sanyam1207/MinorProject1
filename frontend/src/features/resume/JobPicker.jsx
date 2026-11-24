import { RotateCcw } from "lucide-react";
import { errorMessage } from "../../lib/http.js";
import { jobLabel } from "./labUtils.js";

const SOURCES = [
  { id: "campus", label: "Campus drives" },
  { id: "market", label: "Job feed" },
];

/**
 * Job picker over campus drives and market (job feed) jobs. Controlled:
 * the parent loads `jobs` with usePickerJobs(source) and stores `{jobSource, jobId}`.
 */
export default function JobPicker({
  source = "campus",
  jobId,
  jobs = [],
  loading = false,
  error = null,
  onReload,
  onChange,
  allowNone = false,
  noneLabel = "No job (general)",
  label = "Job",
  className = "",
}) {
  const missing = jobId && !loading && !jobs.some((job) => job.id === jobId);
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <span className="text-[10px] font-black uppercase tracking-wide">{label}</span>
        <div className="flex border-[1.5px] border-black" role="group" aria-label="Job source">
          {SOURCES.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={source === item.id}
              onClick={() => item.id !== source && onChange?.({ jobSource: item.id, jobId: null })}
              className={`px-2 py-0.5 text-[10px] font-black uppercase ${source === item.id ? "bg-black text-white" : "bg-white hover:bg-gray-100"}`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex gap-1.5">
        <select
          value={jobId || ""}
          onChange={(event) => onChange?.({ jobSource: source, jobId: event.target.value || null })}
          disabled={loading}
          className="input-stark w-full min-w-0 truncate text-base sm:text-xs disabled:opacity-50"
          aria-label={label}
        >
          <option value="">{loading ? "Loading jobs…" : allowNone ? noneLabel : jobs.length ? "Choose a job" : "No jobs available"}</option>
          {missing && <option value={jobId}>Selected job</option>}
          {jobs.map((job) => (
            <option key={job.id} value={job.id}>
              {jobLabel(job)}
            </option>
          ))}
        </select>
        {error && onReload && (
          <button type="button" onClick={onReload} className="btn-secondary shrink-0 px-2 py-1 text-[10px]" title="Retry loading jobs">
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
      {error && <p className="mt-1 text-[10px] font-bold text-red-700">{errorMessage(error, "Could not load jobs")}</p>}
    </div>
  );
}
