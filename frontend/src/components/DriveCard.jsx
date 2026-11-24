import { useState } from "react";
import { Briefcase, CalendarClock, IndianRupee, MapPin, TriangleAlert } from "lucide-react";
import { eligibilityBadge, typeLabel } from "../features/opportunities/labels.js";
import { formatDate, formatLpa, formatRelative } from "../ui/format.js";
import { useNow } from "../ui/useNow.js";

function CompanyLogo({ name, src }) {
  const [failed, setFailed] = useState(false);
  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
        className="h-10 w-10 shrink-0 border-[1.5px] border-black bg-white object-contain"
      />
    );
  }
  return (
    <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center border-[1.5px] border-black bg-black text-sm font-black uppercase text-white">
      {String(name || "?").trim().charAt(0) || "?"}
    </span>
  );
}

function Fact({ icon: Icon, children }) {
  if (!children) return null;
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1 text-[11px] font-bold text-gray-700">
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{children}</span>
    </span>
  );
}

/**
 * One job (JobVM, features/opportunities/jobVM.js) as a stark card.
 * Props: { job, highlighted?, actions?, onOpen?, showReasons = true }
 * No FIT badge when matchScore is null; "Not disclosed" for a missing package;
 * no invented location; MIN CGPA only when set; no API calls in here.
 */
export default function DriveCard({ job, highlighted = false, actions = null, onOpen, showReasons = true }) {
  const now = useNow(60000);
  if (!job) return null;
  const eligibility = eligibilityBadge(job);
  const deadlineMs = job.deadline ? new Date(job.deadline).getTime() : null;
  const deadlinePassed = deadlineMs !== null && deadlineMs <= now;
  const typeText = [typeLabel(job.jobType), typeLabel(job.workType)].filter(Boolean).join(" · ");
  const matched = new Set(job.matchedSkills.map((skill) => skill.toLowerCase()));
  const skills = job.skillsRequired.slice(0, 8);
  const pay = job.kind === "campus" ? formatLpa(job.packageLpa ?? job.salaryText) : job.salaryText || "Not disclosed";

  return (
    <article
      id={`job-${job.id}`}
      className={`card-stark flex min-w-0 flex-col gap-3 bg-white ${highlighted ? "outline outline-4 outline-yellow-300" : ""}`}
    >
      <header className="flex min-w-0 items-start gap-3">
        <CompanyLogo name={job.companyName} src={job.companyLogo} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[10px] font-extrabold uppercase tracking-wide text-gray-600">{job.companyName}</div>
          {onOpen ? (
            <button type="button" onClick={onOpen} className="block max-w-full break-words text-left text-sm font-black uppercase leading-tight tracking-tight hover:underline">
              {job.roleTitle}
            </button>
          ) : (
            <h4 className="break-words text-sm font-black uppercase leading-tight tracking-tight">{job.roleTitle}</h4>
          )}
          {job.kind === "external" && job.sourceLabels.length > 0 && (
            <div className="mt-0.5 truncate text-[10px] font-semibold text-gray-500">via {job.sourceLabels.join(", ")}</div>
          )}
        </div>
      </header>

      <div className="flex flex-wrap gap-1.5">
        <span className={`badge-stark text-[10px] ${job.kind === "campus" ? "bg-green-100" : "bg-blue-100"}`}>
          {job.kind === "campus" ? "CAMPUS" : "OPEN MARKET"}
        </span>
        {job.isSample && <span className="badge-stark bg-gray-200 text-[10px]">SAMPLE LISTING</span>}
        {job.isNew && <span className="badge-stark bg-yellow-200 text-[10px]">NEW</span>}
        {job.matchScore !== null && <span className="badge-stark bg-purple-100 text-[10px] tabular-nums">FIT {job.matchScore}%</span>}
        {eligibility && <span className={`badge-stark text-[10px] ${eligibility.className}`}>{eligibility.label}</span>}
        {job.minCgpa !== null && <span className="badge-stark text-[10px] tabular-nums">MIN CGPA {job.minCgpa}</span>}
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <Fact icon={IndianRupee}>{pay}</Fact>
        <Fact icon={MapPin}>{job.location}</Fact>
        <Fact icon={Briefcase}>{typeText}</Fact>
        {job.deadline ? (
          <Fact icon={CalendarClock}>
            <span className={deadlinePassed ? "text-red-700" : ""}>
              {deadlinePassed ? "Closed " : "Apply by "}
              {formatDate(job.deadline)} ({formatRelative(job.deadline, now)})
            </span>
          </Fact>
        ) : (
          job.postedAt && <Fact icon={CalendarClock}>Posted {formatRelative(job.postedAt, now)}</Fact>
        )}
      </div>

      {showReasons && job.kind === "campus" && job.isEligible === false && job.eligibilityReasons.length > 0 && (
        <p className="flex items-start gap-1.5 border-l-4 border-red-400 bg-red-50 px-2 py-1.5 text-[11px] font-semibold text-red-900">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {job.eligibilityReasons[0]}
        </p>
      )}

      {skills.length > 0 && (
        <ul className="flex flex-wrap gap-1" aria-label="Skills">
          {skills.map((skill) => (
            <li
              key={skill}
              className={`border border-black px-1.5 py-0.5 text-[10px] font-bold ${matched.has(skill.toLowerCase()) ? "bg-green-100" : "bg-gray-50"}`}
            >
              {skill}
            </li>
          ))}
          {job.skillsRequired.length > skills.length && (
            <li className="px-1 py-0.5 text-[10px] font-bold text-gray-500">+{job.skillsRequired.length - skills.length}</li>
          )}
        </ul>
      )}

      {job.categories.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {job.categories.slice(0, 4).map((category) => (
            <span key={category} className="bg-gray-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-gray-700">
              #{category}
            </span>
          ))}
        </div>
      )}

      {actions && <div className="mt-auto border-t-[1.5px] border-black pt-3">{actions}</div>}
    </article>
  );
}
