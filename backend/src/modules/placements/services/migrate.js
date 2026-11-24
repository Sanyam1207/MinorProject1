// Boot migration (docs/contracts/PLACEMENTS.md §3.8). Idempotent; runs before the server listens.
// Each step has its own try/catch so one failure never blocks the others.
import { Company } from "../../../models/company.models.js";
import { Job } from "../../../models/job.models.js";
import { User } from "../../../models/user.models.js";
import { Application } from "../models/application.model.js";
import { Offer } from "../models/offer.model.js";
import { PlacementPolicy } from "../models/placement-policy.model.js";
import { TrainingEnrollment } from "../models/training-enrollment.model.js";
import { TrainingProgram } from "../models/training-program.model.js";
import { clock } from "../utils/dates.js";
import { academicYearFor } from "./academic-year.js";
import { aiDraftKey } from "./drive.service.js";
import { parsePackageLpa } from "./package.js";

const LEGACY_INDEX = "createdBy_1_sourceSessionId_1";
const LEGACY_STATUS = Object.freeze({ applied: "applied", inprogress: "shortlisted", rejected: "rejected" });
const CREATOR_ROLES = new Set(["tpo", "admin", "company"]);

const logFailure = (step, error) => console.error(`[placements] migration step "${step}" failed:`, error?.message || error);

const isMissingIndexError = (error) => [26, 27].includes(error?.code) || ["IndexNotFound", "NamespaceNotFound"].includes(error?.codeName);

const dropLegacyIndex = async () => {
    try {
        await Job.collection.dropIndex(LEGACY_INDEX);
    } catch (error) {
        if (!isMissingIndexError(error)) throw error;
    }
    await Promise.all([Job, Application, Offer, PlacementPolicy, TrainingProgram, TrainingEnrollment].map((model) => model.createIndexes()));
};

const defaultStatus = async () => {
    const result = await Job.collection.updateMany(
        { $or: [{ status: { $exists: false } }, { status: null }] },
        { $set: { status: "active" } },
    );
    return result.modifiedCount;
};

const migrateEmbeddedApplications = async () => {
    let created = 0;
    const cursor = Job.collection.find({ "applications.0": { $exists: true } }, { projection: { applications: 1, company: 1, college: 1, createdAt: 1 } });
    for await (const job of cursor) {
        if (!job.company) continue;
        for (const entry of job.applications || []) {
            const status = LEGACY_STATUS[entry?.status];
            if (!status || !entry?.student) continue;
            const user = await User.findOne({ student: entry.student }).select("_id college").lean();
            if (!user) continue;
            const appliedAt = job.createdAt instanceof Date ? job.createdAt : clock.now();
            const result = await Application.updateOne(
                { job: job._id, student: user._id },
                {
                    $setOnInsert: {
                        job: job._id,
                        student: user._id,
                        college: job.college ?? user.college ?? null,
                        company: job.company,
                        academicYear: academicYearFor(appliedAt),
                        status,
                        source: "migrated",
                        appliedAt,
                        timeline: [{ status, at: appliedAt, by: null, byRole: "system", byName: "Migration", note: "" }],
                        eligibilitySnapshot: { eligible: null, status: "unknown", reasons: ["Migrated from the legacy job record"], missing: [], checks: [] },
                        resume: null,
                        coverNote: "",
                        offer: null,
                        withdrawnAt: null,
                        decidedAt: status === "rejected" ? appliedAt : null,
                    },
                },
                { upsert: true },
            );
            created += result.upsertedCount || 0;
        }
    }
    await Job.collection.updateMany({ applications: { $exists: true } }, { $unset: { applications: "" } });
    return created;
};

const backfillCreatorFields = async () => {
    const creators = await Job.collection.distinct("createdBy", {
        $or: [{ createdByRole: { $exists: false } }, { college: { $exists: false } }],
    });
    const users = await User.find({ _id: { $in: creators.filter(Boolean) } }).select("role college").lean();
    const byId = new Map(users.map((user) => [String(user._id), user]));
    for (const creatorId of creators) {
        const user = creatorId ? byId.get(String(creatorId)) : null;
        const role = CREATOR_ROLES.has(user?.role) ? user.role : "tpo";
        await Job.collection.updateMany({ createdBy: creatorId, createdByRole: { $exists: false } }, { $set: { createdByRole: role } });
        await Job.collection.updateMany({ createdBy: creatorId, college: { $exists: false } }, { $set: { college: user?.college ?? null } });
    }
    await Job.collection.updateMany({ createdByRole: { $exists: false } }, { $set: { createdByRole: "tpo" } });
    await Job.collection.updateMany({ college: { $exists: false } }, { $set: { college: null } });
};

const backfillPackages = async () => {
    const cursor = Job.collection.find({ packageLpa: { $exists: false } }, { projection: { salary: 1 } });
    for await (const job of cursor) {
        const { min, max } = parsePackageLpa(typeof job.salary === "string" ? job.salary : "");
        await Job.collection.updateOne({ _id: job._id, packageLpa: { $exists: false } }, { $set: { packageLpa: min, packageMaxLpa: max } });
    }
    await Job.collection.updateMany({ packageMaxLpa: { $exists: false } }, [{ $set: { packageMaxLpa: "$packageLpa" } }]);
};

const backfillDates = async () => {
    const now = clock.now();
    await Job.collection.updateMany(
        { status: { $in: ["active", "closed"] }, publishedAt: { $exists: false } },
        [{ $set: { publishedAt: { $ifNull: ["$createdAt", now] } } }],
    );
    await Job.collection.updateMany({ publishedAt: { $exists: false } }, { $set: { publishedAt: null } });
    // Legacy drives were announced long ago (or never); either way they are never announced again.
    await Job.collection.updateMany({ notifiedAt: { $exists: false } }, [{ $set: { notifiedAt: { $ifNull: ["$createdAt", now] } } }]);
};

const backfillDraftKeys = async () => {
    const cursor = Job.collection.find(
        { sourceSessionId: { $type: "string" }, sourceDraftKey: { $exists: false } },
        { projection: { company: 1, title: 1 } },
    );
    for await (const job of cursor) {
        const company = job.company ? await Company.findById(job.company).select("name").lean() : null;
        const key = aiDraftKey({ companyName: company?.name || "", role: job.title || "" });
        try {
            await Job.collection.updateOne({ _id: job._id, sourceDraftKey: { $exists: false } }, { $set: { sourceDraftKey: key } });
        } catch (error) {
            // Two legacy drafts with the same fingerprint in one session: keep the second unique.
            if (error?.code !== 11000) throw error;
            await Job.collection.updateOne({ _id: job._id, sourceDraftKey: { $exists: false } }, { $set: { sourceDraftKey: `${key}:${job._id}` } });
        }
    }
};

/**
 * Run every migration step. Never throws; returns which steps failed.
 * @returns {Promise<{failed: string[]}>}
 */
export const runPlacementMigrations = async () => {
    const steps = [
        ["indexes", dropLegacyIndex],
        ["default-status", defaultStatus],
        ["embedded-applications", migrateEmbeddedApplications],
        ["creator-fields", backfillCreatorFields],
        ["packages", backfillPackages],
        ["dates", backfillDates],
        ["draft-keys", backfillDraftKeys],
    ];
    const failed = [];
    for (const [name, step] of steps) {
        try {
            await step();
        } catch (error) {
            failed.push(name);
            logFailure(name, error);
        }
    }
    return { failed };
};
