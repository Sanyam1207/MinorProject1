import { ArrowLeft, CheckCircle2, CircleHelp, XCircle } from "lucide-react";
import DriveCard from "../../components/DriveCard.jsx";
import { getMarketJob } from "../../lib/api/jobFeed.js";
import { getCampusJob } from "../../lib/api/placements.js";
import { useSocketEvent } from "../../lib/realtime.js";
import { EmptyState, ErrorState, LoadingState, useAsync } from "../../ui/index.js";
import { formatDate, formatDateTime, formatLpa } from "../../ui/format.js";
import { openPanel, usePanel } from "../../workspace/index.js";
import JobActions from "./JobActions.jsx";
import { humanize, typeLabel } from "./labels.js";

const BACK_LABELS = { matched: "AI MATCHES", campus: "CAMPUS DRIVES", market: "OPEN MARKET", tracker: "SAVED JOBS" };

const display = (value) => {
  if (value === null || value === undefined || value === "") return null;
  if (Array.isArray(value)) return value.length ? value.join(", ") : null;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
};

function Facts({ rows }) {
  const visible = rows.filter(([, value]) => value !== null && value !== undefined && value !== "");
  if (!visible.length) return null;
  return (
    <dl className="grid grid-cols-1 gap-px border-[1.5px] border-black bg-black sm:grid-cols-2">
      {visible.map(([label, value]) => (
        <div key={label} className="bg-white p-2">
          <dt className="text-[9px] font-extrabold uppercase text-gray-500">{label}</dt>
          <dd className="break-words text-xs font-bold">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Section({ title, children }) {
  return (
    <section className="space-y-2">
      <h4 className="text-[11px] font-black uppercase tracking-wide">{title}</h4>
      {children}
    </section>
  );
}

function EligibilityChecks({ job }) {
  if (job.kind !== "campus") return null;
  if (!job.eligibilityChecks.length && !job.eligibilityReasons.length) return null;
  return (
    <Section title="Eligibility">
      {job.eligibilityChecks.length > 0 && (
        <ul className="divide-y divide-gray-300 border-[1.5px] border-black">
          {job.eligibilityChecks.map((check) => {
            const Icon = check.passed === true ? CheckCircle2 : check.passed === false ? XCircle : CircleHelp;
            return (
              <li key={check.key || check.label} className="flex items-start gap-2 p-2">
                <Icon
                  className={`mt-0.5 h-4 w-4 shrink-0 ${check.passed === true ? "text-green-700" : check.passed === false ? "text-red-700" : "text-gray-500"}`}
                  aria-hidden="true"
                />
                <div className="min-w-0 text-[11px]">
                  <div className="font-black uppercase">{check.label}</div>
                  <div className="font-semibold text-gray-600">
                    Required: {display(check.required) ?? "—"} · You: {display(check.actual) ?? "not in your profile"}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {job.eligibilityReasons.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-[11px] font-semibold text-red-900">
          {job.eligibilityReasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
      {job.eligibilityStatus === "incomplete" && (
        <button type="button" onClick={() => openPanel("profile")} className="btn-secondary px-2 py-1 text-[10px]">
          COMPLETE MY PROFILE
        </button>
      )}
    </Section>
  );
}

/** DETAIL (jobs.detail {jobId, source, from}): full description, facts, eligibility, actions. */
export default function JobDetail() {
  const { params } = usePanel("jobs.detail");
  const jobId = params.jobId ?? null;
  const source = params.source === "market" ? "market" : "campus";
  const backTab = params.from ?? source;

  const job = useAsync(() => (source === "market" ? getMarketJob(jobId) : getCampusJob(jobId)), [jobId, source], { enabled: Boolean(jobId) });
  useSocketEvent("placement:application", () => {
    if (source === "campus") job.reload();
  });

  const back = (
    <button type="button" onClick={() => openPanel(`jobs.${backTab}`)} className="btn-secondary min-h-11 px-3 py-1.5 text-xs sm:min-h-0">
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
      BACK TO {BACK_LABELS[backTab] ?? "JOBS"}
    </button>
  );

  if (!jobId) {
    return (
      <div className="space-y-3">
        {back}
        <EmptyState title="No job selected" text="Pick a job from one of the lists to see its details." />
      </div>
    );
  }
  if (job.error && (!job.data || job.data.id !== jobId)) {
    const gone = job.error?.status === 404;
    return (
      <div className="space-y-3">
        {back}
        {gone ? (
          <EmptyState
            title={source === "market" ? "This job is no longer in the feed" : "This drive is not available"}
            text={source === "market" ? "It may have been removed by the source." : "It may have been closed or removed by your placement office."}
          />
        ) : (
          <ErrorState error={job.error} title="COULD NOT LOAD THIS JOB" onRetry={job.reload} />
        )}
      </div>
    );
  }
  if (!job.data || (job.loading && job.data.id !== jobId)) return <LoadingState label="LOADING JOB…" />;

  const vm = job.data;
  const facts =
    vm.kind === "campus"
      ? [
          ["Package", formatLpa(vm.packageLpa ?? vm.salaryText)],
          ["Location", vm.location],
          ["Employment", typeLabel(vm.jobType)],
          ["Apply by", vm.deadline ? formatDateTime(vm.deadline) : null],
          ["Drive date", vm.driveDate ? formatDate(vm.driveDate) : null],
          ["Min CGPA", vm.minCgpa],
          ["Max backlogs", vm.maxBacklogs],
          ["Branches", display(vm.eligibleBranches)],
          ["Batches", display(vm.graduationYears)],
          ["Match", vm.matchScore !== null ? `${vm.matchScore}%` : null],
          ["Status", vm.status ? humanize(vm.status) : null],
        ]
      : [
          ["Salary", vm.salaryText ?? "Not disclosed"],
          ["Location", vm.location],
          ["Job type", typeLabel(vm.jobType)],
          ["Work type", typeLabel(vm.workType)],
          ["Experience", vm.experience],
          ["Posted", vm.postedAt ? formatDate(vm.postedAt) : null],
          ["Source", display(vm.sourceLabels)],
          ["Match", vm.matchScore !== null ? `${vm.matchScore}%` : null],
        ];

  return (
    <div className="space-y-4">
      {back}
      <DriveCard
        job={vm}
        showReasons={false}
        actions={<JobActions job={vm} from={backTab} variant="detail" onChange={(patch) => job.setData((previous) => (previous ? { ...previous, ...patch } : previous))} />}
      />
      {vm.kind === "campus" && vm.canApply === false && vm.applyBlockedReason && !vm.applicationStatus && (
        <p className="border-2 border-black bg-yellow-100 p-2 text-[11px] font-bold">{vm.applyBlockedReason}</p>
      )}
      <Facts rows={facts} />
      <EligibilityChecks job={vm} />
      {vm.missingSkills.length > 0 && (
        <Section title="Skills to build">
          <div className="flex flex-wrap gap-1">
            {vm.missingSkills.map((skill) => (
              <span key={skill} className="border border-black bg-orange-100 px-1.5 py-0.5 text-[10px] font-bold">
                {skill}
              </span>
            ))}
          </div>
        </Section>
      )}
      {vm.rounds.length > 0 && (
        <Section title="Selection rounds">
          <ol className="space-y-1.5">
            {vm.rounds.map((round, index) => (
              <li key={round.id} className="flex items-start gap-2 border-l-4 border-black bg-gray-50 px-2 py-1.5 text-[11px]">
                <span className="font-black tabular-nums">{index + 1}.</span>
                <div className="min-w-0">
                  <div className="font-black uppercase">{round.name}</div>
                  <div className="font-semibold text-gray-600">
                    {[round.at ? formatDateTime(round.at) : "Date TBA", round.mode ? humanize(round.mode) : null, round.venue].filter(Boolean).join(" · ")}
                  </div>
                  {round.notes && <div className="mt-0.5 text-gray-700">{round.notes}</div>}
                </div>
              </li>
            ))}
          </ol>
        </Section>
      )}
      {vm.selectionProcess && (
        <Section title="Selection process">
          <p className="whitespace-pre-wrap text-xs font-medium text-gray-800">{vm.selectionProcess}</p>
        </Section>
      )}
      <Section title="Description">
        {vm.jdText ? (
          <p className="whitespace-pre-wrap break-words text-xs font-medium leading-relaxed text-gray-800">{vm.jdText}</p>
        ) : (
          <p className="text-[11px] font-semibold text-gray-500">No description provided.</p>
        )}
      </Section>
    </div>
  );
}
