// Pure helpers for the TPO / recruiter panels (no React, no DOM at import time).
// Field names follow PLACEMENTS.md §6.1 "Drive input" and the backend views.

export const DRIVE_STATUSES = Object.freeze(["draft", "pending", "active", "closed", "rejected"]);
export const DRIVE_STATUS_COLORS = Object.freeze({
  draft: "bg-gray-100",
  pending: "bg-yellow-100",
  active: "bg-green-200",
  closed: "bg-gray-200",
  rejected: "bg-red-100",
});

export const APPLICATION_STATUSES = Object.freeze(["applied", "shortlisted", "interview", "offered", "hired", "rejected", "withdrawn"]);
/** Statuses staff / recruiters may set directly (offered/hired go through the offer flow). */
export const STAFF_SETTABLE_STATUSES = Object.freeze(["applied", "shortlisted", "interview", "rejected"]);
export const APPLICATION_STATUS_LABELS = Object.freeze({
  applied: "Applied",
  shortlisted: "Shortlisted",
  interview: "Interview",
  offered: "Offered",
  hired: "Hired",
  rejected: "Not selected",
  withdrawn: "Withdrawn",
});
/** Statuses from which an offer may be extended (PLACEMENTS.md §6.3). */
export const OFFERABLE_STATUSES = Object.freeze(["applied", "shortlisted", "interview"]);

export const OFFER_STATUSES = Object.freeze(["extended", "accepted", "rejected", "withdrawn", "expired", "placed"]);
export const OFFER_STATUS_LABELS = Object.freeze({
  extended: "Pending response",
  accepted: "Accepted",
  rejected: "Declined",
  withdrawn: "Withdrawn",
  expired: "Expired",
  placed: "Placed",
});

export const TRAINING_TYPES = Object.freeze(["aptitude", "technical", "soft-skills", "certification", "workshop", "mock-interview", "other"]);
export const DELIVERY_MODES = Object.freeze(["online", "offline", "hybrid"]);
export const PROGRAM_STATUSES = Object.freeze(["upcoming", "ongoing", "completed", "cancelled"]);
export const PROGRAM_STATUS_COLORS = Object.freeze({
  upcoming: "bg-blue-100",
  ongoing: "bg-green-200",
  completed: "bg-gray-200",
  cancelled: "bg-red-100",
});

export const ISSUE_STATUSES = Object.freeze(["open", "in_progress", "resolved", "closed"]);
export const ISSUE_STATUS_COLORS = Object.freeze({
  open: "bg-red-100",
  in_progress: "bg-yellow-100",
  resolved: "bg-green-200",
  closed: "bg-gray-200",
});

export const EMPLOYMENT_TYPES = Object.freeze(["Full-time", "Internship", "Internship + PPO", "Part-time", "Contract"]);

/** "a, b ,, c" → ["a","b","c"] (also accepts arrays). */
export const splitList = (value) => {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value ?? "")
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
};

export const joinList = (value) => (Array.isArray(value) ? value.filter(Boolean).join(", ") : String(value ?? ""));

const toNumberOrNull = (value) => {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/** ISO date → "YYYY-MM-DD" in the browser's zone (for <input type="date">). */
export const toDateInput = (value) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/** ISO → "YYYY-MM-DDTHH:mm" (for <input type="datetime-local">). */
export const toDateTimeInput = (value) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${toDateInput(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/** A local datetime-input value → ISO string (null when empty / invalid). */
export const fromDateTimeInput = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

export const emptyRound = () => ({ name: "", at: "", venue: "", mode: "offline", notes: "" });

export const emptyDriveForm = () => ({
  title: "",
  companyName: "",
  description: "",
  packageLpa: "",
  location: "",
  employmentType: "",
  deadline: "",
  driveDate: "",
  minCgpa: "",
  maxBacklogs: "",
  branches: "",
  graduationYears: "",
  min10th: "",
  min12th: "",
  skills: "",
  selectionProcess: "",
  rounds: [],
  status: "active",
});

/** StaffJobView → form state. */
export const driveToForm = (job) => {
  if (!job) return emptyDriveForm();
  return {
    title: job.title || "",
    companyName: job.companyName || job.company?.name || "",
    description: job.description || "",
    packageLpa: job.salary && job.salary !== "not disclosed" ? job.salary : job.packageLpa ?? "",
    location: job.location || "",
    employmentType: job.employmentType || "",
    deadline: toDateInput(job.applicationDeadline || job.deadline),
    driveDate: toDateInput(job.driveDate),
    minCgpa: job.minimumCgpa ?? job.minCgpa ?? "",
    maxBacklogs: job.maximumBacklogs ?? "",
    branches: joinList(job.eligibleBranches),
    graduationYears: joinList(job.graduationYears),
    min10th: job.min10thPercentage ?? "",
    min12th: job.min12thPercentage ?? "",
    skills: joinList(job.skills || job.skillsRequired),
    selectionProcess: job.selectionProcess || "",
    rounds: (job.rounds || []).map((round) => ({
      name: round.name || "",
      at: toDateTimeInput(round.at),
      venue: round.venue || "",
      mode: round.mode || "offline",
      notes: round.notes || "",
    })),
    status: job.status === "draft" ? "draft" : "active",
  };
};

/**
 * Validate the drive form. → `{ field: message }` (empty object when valid).
 * `scope` "company" does not need a company name (the server uses the recruiter's company).
 */
export const validateDriveForm = (form, { scope = "tpo", isEdit = false } = {}) => {
  const errors = {};
  const title = String(form.title ?? "").trim();
  if (title.length < 2) errors.title = "Enter the role title (at least 2 characters).";
  if (scope !== "company" && !isEdit && !String(form.companyName ?? "").trim()) errors.companyName = "Enter the company name.";
  if (!isEdit && !String(form.description ?? "").trim()) errors.description = "Add a job description.";
  if (!isEdit && !form.deadline && !form.driveDate) errors.deadline = "Set an application deadline or a drive date.";
  if (form.deadline && form.driveDate && form.driveDate < form.deadline) errors.driveDate = "The drive date must be on or after the deadline.";
  const cgpa = toNumberOrNull(form.minCgpa);
  if (String(form.minCgpa ?? "").trim() !== "" && (cgpa === null || cgpa < 0 || cgpa > 10)) errors.minCgpa = "CGPA must be between 0 and 10.";
  const backlogs = toNumberOrNull(form.maxBacklogs);
  if (String(form.maxBacklogs ?? "").trim() !== "" && (backlogs === null || backlogs < 0 || backlogs > 50 || !Number.isInteger(backlogs))) {
    errors.maxBacklogs = "Whole number between 0 and 50.";
  }
  for (const key of ["min10th", "min12th"]) {
    const value = toNumberOrNull(form[key]);
    if (String(form[key] ?? "").trim() !== "" && (value === null || value < 0 || value > 100)) errors[key] = "Percentage between 0 and 100.";
  }
  const years = splitList(form.graduationYears);
  if (years.some((year) => !/^\d{4}$/.test(year) || Number(year) < 2000 || Number(year) > 2100)) {
    errors.graduationYears = "Use four-digit years, e.g. 2026, 2027.";
  }
  (form.rounds || []).forEach((round, index) => {
    if (!String(round.name ?? "").trim()) errors[`round${index}`] = "Each round needs a name.";
  });
  return errors;
};

/**
 * Form → POST/PATCH /jobs body (canonical PLACEMENTS.md names). Empty optional
 * fields are omitted on create; on edit they are sent as null/[] so clearing works.
 */
export const toDrivePayload = (form, { scope = "tpo", isEdit = false, original = null } = {}) => {
  const payload = {};
  const text = (key, value) => {
    const trimmed = String(value ?? "").trim();
    if (trimmed) payload[key] = trimmed;
    else if (isEdit) payload[key] = "";
  };
  const number = (key, value) => {
    const parsed = toNumberOrNull(value);
    if (parsed !== null) payload[key] = parsed;
    else if (isEdit) payload[key] = null;
  };
  const list = (key, value) => {
    const items = splitList(value);
    if (items.length || isEdit) payload[key] = items;
  };

  payload.title = String(form.title ?? "").trim();
  if (scope !== "company" && String(form.companyName ?? "").trim()) payload.companyName = String(form.companyName).trim();
  if (String(form.description ?? "").trim() || !isEdit) payload.description = String(form.description ?? "").trim();
  text("packageLpa", form.packageLpa);
  text("location", form.location);
  text("employmentType", form.employmentType);
  // On edit an unchanged deadline is not re-sent (a past deadline would be rejected as DEADLINE_IN_PAST).
  if (form.deadline && !(isEdit && original && original.deadline === form.deadline)) payload.applicationDeadline = form.deadline;
  if (form.driveDate) {
    if (!(isEdit && original && original.driveDate === form.driveDate)) payload.driveDate = form.driveDate;
  } else if (isEdit && original?.driveDate) payload.driveDate = null;
  number("minimumCgpa", form.minCgpa);
  number("maximumBacklogs", form.maxBacklogs);
  number("min10thPercentage", form.min10th);
  number("min12thPercentage", form.min12th);
  list("eligibleBranches", form.branches);
  list("graduationYears", form.graduationYears);
  list("skills", form.skills);
  text("selectionProcess", form.selectionProcess);
  const rounds = (form.rounds || [])
    .filter((round) => String(round.name ?? "").trim())
    .map((round) => {
      const entry = { name: String(round.name).trim(), mode: round.mode === "online" ? "online" : "offline" };
      const at = fromDateTimeInput(round.at);
      if (at) entry.at = at;
      if (String(round.venue ?? "").trim()) entry.venue = String(round.venue).trim();
      if (String(round.notes ?? "").trim()) entry.notes = String(round.notes).trim();
      return entry;
    });
  if (rounds.length || isEdit) payload.rounds = rounds;
  if (scope !== "company" && !isEdit) payload.status = form.status === "draft" ? "draft" : "active";
  if (isEdit && payload.packageLpa === "") delete payload.packageLpa;
  return payload;
};

/** Sum of a counts object (ignores non-numbers). */
export const sumCounts = (counts, keys) => {
  if (!counts) return 0;
  const list = keys || Object.keys(counts);
  return list.reduce((sum, key) => sum + (Number.isFinite(counts[key]) ? counts[key] : 0), 0);
};

/** "Computer Science" → "computer-science" (CSV file names). */
export const slug = (value) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

/** Today's date as YYYY-MM-DD (pass a Date for determinism). */
export const isoDay = (date = new Date()) => toDateInput(date);

/** Current academic year "2026-27" (July → June), as the backend computes it. */
export const academicYearOf = (date = new Date()) => {
  const year = date.getFullYear();
  const start = date.getMonth() >= 6 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
};

export const isValidAcademicYear = (value) => {
  const match = /^(\d{4})-(\d{2})$/.exec(String(value ?? ""));
  if (!match) return false;
  return (Number(match[1]) + 1) % 100 === Number(match[2]);
};

export const DEFAULT_POLICY = Object.freeze({
  enforceOneOffer: true,
  allowDreamUpgrade: true,
  dreamMultiplier: 1.5,
  superDreamMultiplier: 2,
  maxPendingOffers: 3,
  offerExpiryDays: 7,
});

/** Client-side policy validation mirroring PLACEMENTS.md §3.4. → `{ field: message }`. */
export const validatePolicy = (policy) => {
  const errors = {};
  if (!isValidAcademicYear(policy.academicYear)) errors.academicYear = "Use the form 2026-27.";
  const dream = Number(policy.dreamMultiplier);
  const superDream = Number(policy.superDreamMultiplier);
  if (!(dream >= 1.1 && dream <= 5)) errors.dreamMultiplier = "Between 1.1 and 5.";
  if (!(superDream >= 1.5 && superDream <= 10)) errors.superDreamMultiplier = "Between 1.5 and 10.";
  else if (Number.isFinite(dream) && superDream < dream) errors.superDreamMultiplier = "Must be at least the dream multiplier.";
  const pending = Number(policy.maxPendingOffers);
  if (!Number.isInteger(pending) || pending < 1 || pending > 10) errors.maxPendingOffers = "Whole number between 1 and 10.";
  const expiry = Number(policy.offerExpiryDays);
  if (!Number.isInteger(expiry) || expiry < 1 || expiry > 30) errors.offerExpiryDays = "Whole number between 1 and 30.";
  return errors;
};

export const emptySession = () => ({ date: "", time: "", venue: "", topic: "", durationMinutes: "" });

export const emptyProgramForm = () => ({
  title: "",
  description: "",
  type: "technical",
  instructor: "",
  deliveryMode: "offline",
  capacity: "60",
  registrationDeadline: "",
  branches: "",
  graduationYears: "",
  minCgpa: "",
  schedule: [emptySession()],
});

export const programToForm = (program) => {
  if (!program) return emptyProgramForm();
  return {
    title: program.title || "",
    description: program.description || "",
    type: program.type || "other",
    instructor: program.instructor || "",
    deliveryMode: program.deliveryMode || "offline",
    capacity: String(program.capacity ?? ""),
    registrationDeadline: toDateInput(program.registrationDeadline),
    branches: joinList(program.audience?.branches),
    graduationYears: joinList(program.audience?.graduationYears),
    minCgpa: program.audience?.minCgpa ?? "",
    schedule: (program.schedule || []).length
      ? program.schedule.map((session) => ({
        date: toDateInput(session.date),
        time: session.time || "",
        venue: session.venue && session.venue !== "TBA" ? session.venue : "",
        topic: session.topic || "",
        durationMinutes: session.durationMinutes ?? "",
      }))
      : [emptySession()],
  };
};

export const validateProgramForm = (form) => {
  const errors = {};
  if (!String(form.title ?? "").trim()) errors.title = "Enter a title.";
  const capacity = Number(form.capacity);
  if (!Number.isInteger(capacity) || capacity < 1) errors.capacity = "Capacity must be a whole number of at least 1.";
  const sessions = (form.schedule || []).filter((session) => session.date);
  if (sessions.length === 0) errors.schedule = "Add at least one session with a date.";
  if ((form.schedule || []).some((session) => {
    const minutes = String(session.durationMinutes ?? "").trim();
    return minutes && (!(Number(minutes) >= 15) || Number(minutes) > 600);
  })) {
    errors.schedule = "Session duration must be 15–600 minutes.";
  }
  const cgpa = String(form.minCgpa ?? "").trim();
  if (cgpa && !(Number(cgpa) >= 0 && Number(cgpa) <= 10)) errors.minCgpa = "CGPA must be between 0 and 10.";
  return errors;
};

/** Program form → POST/PATCH /training body. */
export const toProgramPayload = (form) => {
  const cgpa = toNumberOrNull(form.minCgpa);
  return {
    title: String(form.title ?? "").trim(),
    description: String(form.description ?? "").trim(),
    type: form.type || "other",
    instructor: String(form.instructor ?? "").trim(),
    deliveryMode: form.deliveryMode || "offline",
    capacity: Number(form.capacity),
    registrationDeadline: form.registrationDeadline || null,
    audience: {
      branches: splitList(form.branches),
      graduationYears: splitList(form.graduationYears),
      minCgpa: cgpa,
    },
    schedule: (form.schedule || [])
      .filter((session) => session.date)
      .map((session) => {
        const entry = { date: session.date };
        if (String(session.time ?? "").trim()) entry.time = String(session.time).trim();
        if (String(session.venue ?? "").trim()) entry.venue = String(session.venue).trim();
        if (String(session.topic ?? "").trim()) entry.topic = String(session.topic).trim();
        const minutes = toNumberOrNull(session.durationMinutes);
        if (minutes !== null) entry.durationMinutes = minutes;
        return entry;
      }),
  };
};

/** Seat usage percentage without dividing by zero. */
export const seatPercent = (enrolled, capacity) => {
  const cap = Number(capacity);
  if (!Number.isFinite(cap) || cap <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((Number(enrolled) || 0) / cap * 100)));
};

/** Human label for a snake/kebab status. */
export const humanize = (value) => String(value ?? "").replace(/[-_]+/g, " ").trim();
