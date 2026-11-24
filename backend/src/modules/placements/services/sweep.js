// The placements.sweep background job (docs/contracts/PLACEMENTS.md §11). Each step is independent,
// processes at most 500 documents per tick and reads "now" from clock.now() (tests pin it).
import { Job } from "../../../models/job.models.js";
import { placementsConfig } from "../config.js";
import { Offer } from "../models/offer.model.js";
import { clock } from "../utils/dates.js";
import { findEligibleStudentIds } from "./eligibility.service.js";
import * as events from "./events.js";
import { expireOffer } from "./offer.service.js";
import { sweepTrainingStatuses } from "./training.service.js";

const BATCH = 500;
const HOUR_MS = 60 * 60 * 1000;

const autoCloseDrives = async (now) => {
    const due = await Job.find({ status: "active", applicationDeadline: { $lte: now } }).select("_id company college").limit(BATCH).lean();
    let closed = 0;
    for (const job of due) {
        const updated = await Job.findOneAndUpdate(
            { _id: job._id, status: "active" },
            { $set: { status: "closed", closedReason: "deadline", closedAt: now } },
            { returnDocument: "after" },
        ).lean();
        if (!updated) continue;
        closed += 1;
        events.jobChanged(updated, "closed");
    }
    return closed;
};

const expireDueOffers = async (now) => {
    const due = await Offer.find({ status: "extended", expiresAt: { $lte: now } }).limit(BATCH).lean();
    let expired = 0;
    for (const offer of due) if (await expireOffer(offer)) expired += 1;
    return expired;
};

const remindExpiringOffers = async (now) => {
    const hours = placementsConfig.offerReminderHours;
    if (!(hours > 0)) return 0;
    const windowMs = hours * HOUR_MS;
    const due = await Offer.find({
        status: "extended",
        expiresAt: { $gt: now, $lte: new Date(now.getTime() + windowMs) },
        reminderSentAt: null,
    }).limit(BATCH).lean();
    let sent = 0;
    for (const offer of due) {
        const claim = await Offer.updateOne({ _id: offer._id, reminderSentAt: null }, { $set: { reminderSentAt: now } });
        if (claim.modifiedCount !== 1) continue;
        // Created inside the reminder window: the "new offer" notification already said when it expires.
        if (offer.createdAt && new Date(offer.createdAt).getTime() > new Date(offer.expiresAt).getTime() - windowMs) continue;
        await events.offerExpiring(offer);
        sent += 1;
    }
    return sent;
};

const remindDriveDeadlines = async (now) => {
    const hours = placementsConfig.driveDeadlineReminderHours;
    if (!(hours > 0)) return 0;
    const windowMs = hours * HOUR_MS;
    const due = await Job.find({
        status: "active",
        applicationDeadline: { $gt: now, $lte: new Date(now.getTime() + windowMs) },
        deadlineReminderSentAt: null,
    }).populate("company", "name").limit(BATCH).lean();
    let reminded = 0;
    for (const job of due) {
        const claim = await Job.updateOne({ _id: job._id, deadlineReminderSentAt: null }, { $set: { deadlineReminderSentAt: now } });
        if (claim.modifiedCount !== 1) continue;
        const publishedAt = job.publishedAt || job.createdAt;
        if (publishedAt && new Date(publishedAt).getTime() > new Date(job.applicationDeadline).getTime() - windowMs) continue;
        const recipients = await findEligibleStudentIds(job, { excludeApplied: true });
        reminded += await events.deadlineReminder(job, recipients);
    }
    return reminded;
};

/**
 * One sweep tick. Never throws; returns per-step counts (null = the step failed).
 */
export const runSweep = async () => {
    const now = clock.now();
    const result = {};
    const steps = [
        ["closedDrives", () => autoCloseDrives(now)],
        ["expiredOffers", () => expireDueOffers(now)],
        ["offerReminders", () => remindExpiringOffers(now)],
        ["deadlineReminders", () => remindDriveDeadlines(now)],
        ["training", () => sweepTrainingStatuses()],
    ];
    for (const [name, step] of steps) {
        try {
            result[name] = await step();
        } catch (error) {
            result[name] = null;
            console.error(`[placements] sweep step "${name}" failed:`, error?.message || error);
        }
    }
    return result;
};
