import { Job } from "../models/job.models.js";
import { Company } from "../models/company.models.js";

const toOptionalNumber = (value) => {
    if (value === "" || value === null || value === undefined) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
};

const toIsoString = (value) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

export const getEligibilityJobs = async () => {
    // Older jobs were created before `status` was added to the schema. The
    // Available Jobs UI treats those records as active, so eligibility
    // metadata must apply the same rule instead of silently dropping them.
    const jobs = await Job.find({
        $or: [
            { status: "active" },
            { status: { $exists: false } },
            { status: null },
        ],
    })
        .populate("company", "name")
        .sort({ createdAt: -1 })
        .lean();

    return jobs.map((job) => ({
        job_id: job._id.toString(),
        job_title: job.title,
        description: job.description,
        company_id: job.company?._id?.toString() || null,
        company_name: job.company?.name || "Unknown Company",
        salary: job.salary || "not disclosed",
        location: job.location || "",
        employment_type: job.employmentType || "",
        min_cgpa: job.minimumCgpa ?? null,
        max_backlogs: job.maximumBacklogs ?? null,
        allowed_branches: job.eligibleBranches || [],
        allowed_graduation_years: (job.graduationYears || []).map(Number).filter(Number.isFinite),
        skills: job.skills || [],
        selection_process: job.selectionProcess || "",
        application_deadline: toIsoString(job.applicationDeadline),
        status: job.status || "active",
    }));
};

export const persistConfirmedJob = async ({ job, user, sessionId }) => {
    if (!user || !["tpo", "admin"].includes(user.role)) {
        throw new Error("Only an authenticated TPO can create a job");
    }
    if (!job?.company_name || !job?.job_role || !job?.job_description || !job?.app_deadline) {
        throw new Error("Confirmed job payload is missing required fields");
    }

    const escapedCompanyName = job.company_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let company = await Company.findOne({
        name: { $regex: `^${escapedCompanyName}$`, $options: "i" },
    });
    if (!company) company = await Company.create({ name: job.company_name.trim() });

    const applicationDeadline = new Date(job.app_deadline);
    if (Number.isNaN(applicationDeadline.getTime())) {
        throw new Error("Confirmed job has an invalid application deadline");
    }

    const update = {
        title: job.job_role.trim(),
        description: job.job_description.trim(),
        company: company._id,
        salary: job.salary || "not disclosed",
        eligibleBranches: Array.isArray(job.eligible_branches) ? job.eligible_branches : [],
        location: job.location || "",
        employmentType: job.employment_type || "",
        graduationYears: Array.isArray(job.graduation_years) ? job.graduation_years : [],
        skills: Array.isArray(job.skills) ? job.skills : [],
        selectionProcess: job.selection_process || "",
        applicationDeadline,
        createdBy: user._id,
        sourceSessionId: sessionId,
        status: "active",
    };
    const minimumCgpa = toOptionalNumber(job.minimum_cgpa);
    const maximumBacklogs = toOptionalNumber(job.maximum_backlogs);
    if (minimumCgpa !== undefined) update.minimumCgpa = minimumCgpa;
    if (maximumBacklogs !== undefined) update.maximumBacklogs = maximumBacklogs;

    return Job.findOneAndUpdate(
        { createdBy: user._id, sourceSessionId: sessionId },
        { $set: update },
        { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
    );
};
