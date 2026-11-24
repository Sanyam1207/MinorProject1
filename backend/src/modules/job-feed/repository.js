// Persistence for ExternalJob (docs/contracts/JOB-FEED.md §3.2), ported from
// Matchy's job.repository.js with: insertedIds, isSample handling, source counts
// and a backfill pass so a later source can fill fields the first one lacked.
import { SAMPLE_SOURCE } from "./constants.js";
import { ExternalJob } from "./models/external-job.model.js";

// Fields a later source may fill in when the stored job has none.
export const BACKFILL_FIELDS = Object.freeze([
    "company", "companyLogo", "location", "experience", "salary", "jobType", "workType", "applyUrl", "description",
]);

function withoutEmptyValues(fields) {
    return Object.fromEntries(Object.entries(fields).filter(([, value]) => value != null));
}

export class JobRepository {
    list(filter, { skip = 0, limit = 20, sort = { postedAt: -1, _id: -1 } } = {}) {
        return ExternalJob.find(filter).sort(sort).skip(skip).limit(limit).lean();
    }

    count(filter) {
        return ExternalJob.countDocuments(filter);
    }

    // Every stored category with how many jobs have it, most common first.
    async listCategories() {
        const rows = await ExternalJob.aggregate([
            { $unwind: "$categories" },
            { $group: { _id: "$categories", count: { $sum: 1 } } },
            { $sort: { count: -1, _id: 1 } },
        ]);
        return rows.map((row) => ({ value: row._id, count: row.count }));
    }

    // How many distinct jobs each source has reported: {<sourceName>: count}.
    async listSourceCounts() {
        const rows = await ExternalJob.aggregate([
            { $unwind: "$sources" },
            { $group: { _id: { source: "$sources.name", job: "$_id" } } },
            { $group: { _id: "$_id.source", count: { $sum: 1 } } },
        ]);
        return Object.fromEntries(rows.map((row) => [row._id, row.count]));
    }

    // One upsert per dedupeKey: the first version of a job is kept, while postedAt, lastSeenAt, sources and
    // categories keep up to date. A second pass fills fields the stored job is missing (never overwrites).
    async upsertMany(jobs, seenAt = new Date(), { source = null } = {}) {
        if (!jobs.length) return { inserted: 0, existing: 0, insertedIds: [] };
        const isSample = source === SAMPLE_SOURCE;

        const result = await ExternalJob.bulkWrite(
            jobs.map(({ dedupeKey, postedAt, sources, categories, ...fields }) => ({
                updateOne: {
                    filter: { dedupeKey },
                    update: {
                        $setOnInsert: { ...withoutEmptyValues(fields), ...(isSample ? { isSample: true } : {}) },
                        $max: { postedAt },
                        $set: { lastSeenAt: seenAt, ...(isSample ? {} : { isSample: false }) },
                        $addToSet: { sources: { $each: sources }, categories: { $each: categories } },
                    },
                    upsert: true,
                },
            })),
            { ordered: false },
        );

        const upserted = result.upsertedIds || {};
        const insertedIndexes = new Set(Object.keys(upserted).map(Number));
        const insertedIds = Object.values(upserted);

        // Backfill through the native driver: Mongoose 9 rejects pipeline updates without `updatePipeline`.
        const backfill = [];
        jobs.forEach((job, index) => {
            if (insertedIndexes.has(index)) return;
            const present = BACKFILL_FIELDS.filter((field) => job[field] != null);
            if (!present.length) return;
            const set = Object.fromEntries(present.map((field) => [field, { $ifNull: [`$${field}`, { $literal: job[field] }] }]));
            set.updatedAt = "$$NOW";
            backfill.push({ updateOne: { filter: { dedupeKey: job.dedupeKey }, update: [{ $set: set }] } });
        });
        if (backfill.length) await ExternalJob.collection.bulkWrite(backfill, { ordered: false });

        return {
            inserted: result.upsertedCount ?? insertedIds.length,
            existing: result.matchedCount ?? 0,
            insertedIds,
        };
    }
}

export const jobRepository = new JobRepository();
