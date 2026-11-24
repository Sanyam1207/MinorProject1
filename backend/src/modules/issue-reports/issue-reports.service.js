// Issue reports: create (anyone), triage (TPO/admin) — docs/contracts/AUTH-FACULTY.md §9, §11.
//
// Signed-in reporters: name, email, user, role and college always come from
// the account (the body cannot spoof them) and the college's TPO(s) plus all
// active admins get an `issue.new` notification. Anonymous reports notify
// nobody (spam control); they only appear in the list.
import mongoose from "mongoose";
import { escapeRegex, fail, intParam, isObjectId } from "../../core/http.js";
import { College } from "../../models/college.models.js";
import { User } from "../../models/user.models.js";
import { logAuthEvent } from "../../services/auth-policy.service.js";
import { notify } from "../notifications/notify.js";
import { ISSUE_LIMITS, ISSUE_STATUSES, IssueReport } from "./issue-report.model.js";

export const ISSUE_THANKS_MESSAGE = "Thanks for reporting this. We'll take a look soon.";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STATUS_LABELS = { open: "Open", in_progress: "In progress", resolved: "Resolved", closed: "Closed" };

const validation = (message, field) => fail(400, message, "VALIDATION", field ? { field } : {});
const asText = (value) => (typeof value === "string" ? value.trim() : "");

const validDescription = (value) => {
    const description = asText(value);
    if (!description) return null;
    if (description.length > ISSUE_LIMITS.description) {
        throw validation(`Please keep the description under ${ISSUE_LIMITS.description} characters.`, "description");
    }
    return description;
};

const notifyStaffOfNewReport = async (report, reporter) => {
    try {
        const recipients = new Set();
        if (report.college) {
            const college = await College.findById(report.college).select("tpo").lean();
            if (college?.tpo) recipients.add(String(college.tpo));
            const tpos = await User.find({ role: "tpo", college: report.college, isActive: { $ne: false } }).select("_id").lean();
            for (const tpo of tpos) recipients.add(String(tpo._id));
        }
        const admins = await User.find({ role: "admin", isActive: { $ne: false } }).select("_id").lean();
        for (const admin of admins) recipients.add(String(admin._id));
        recipients.delete(String(reporter._id));
        if (recipients.size === 0) return;
        await notify([...recipients], {
            type: "issue.new",
            title: `New issue report from ${report.name}`,
            body: report.description.slice(0, 200),
            ui: { panel: "tpo.issues", params: { reportId: String(report._id) } },
            data: { reportId: String(report._id) },
            priority: "low",
        });
    } catch (error) {
        logAuthEvent("issue-reports", "new-report notification failed", { error: error?.message || String(error) }, "warn");
    }
};

/**
 * Create a report. With `user`, the identity comes from the account.
 * A non-empty honeypot `website` pretends success and stores nothing.
 * @returns {Promise<{id: string, stored: boolean}>}
 */
export const createIssueReport = async ({ user = null, body = {}, userAgent } = {}) => {
    const input = body && typeof body === "object" ? body : {};
    if (typeof input.website === "string" && input.website.trim()) {
        // Honeypot: bots fill hidden fields. Same answer, nothing stored.
        return { id: String(new mongoose.Types.ObjectId()), stored: false };
    }
    const description = validDescription(input.description);

    let identity;
    if (user) {
        if (!description) throw validation("Please describe the issue.", "description");
        identity = {
            name: String(user.name || user.email || "User").slice(0, ISSUE_LIMITS.name),
            email: String(user.email || "").toLowerCase(),
            user: user._id,
            role: user.role || null,
            college: user.college?._id ?? user.college ?? null,
        };
    } else {
        const name = asText(input.name);
        const email = asText(input.email);
        if (!name || !email || !description) throw validation("Name, email, and issue description are required.");
        if (name.length > ISSUE_LIMITS.name) throw validation(`Name must be at most ${ISSUE_LIMITS.name} characters.`, "name");
        if (email.length > ISSUE_LIMITS.email || !EMAIL_RE.test(email)) throw validation("Please enter a valid email address.", "email");
        identity = { name, email: email.toLowerCase(), user: null, role: null, college: null };
    }

    const report = await IssueReport.create({
        ...identity,
        description,
        page: asText(input.page).slice(0, ISSUE_LIMITS.page),
        userAgent: typeof userAgent === "string" ? userAgent.slice(0, ISSUE_LIMITS.userAgent) : undefined,
    });
    if (user) await notifyStaffOfNewReport(report, user);
    return { id: String(report._id), stored: true };
};

/** Reports visible to the actor: tpo → own college + anonymous; admin → all. */
const scopeFilter = (actor) => {
    if (actor?.role === "admin") return {};
    const college = actor?.college?._id ?? actor?.college ?? null;
    return { college: { $in: college ? [college, null] : [null] } };
};

const reportView = (report) => ({
    _id: report._id,
    name: report.name,
    email: report.email,
    description: report.description,
    page: report.page || "",
    status: report.status,
    note: report.note ?? "",
    role: report.role ?? null,
    user: report.user && typeof report.user === "object" && report.user._id
        ? { _id: report.user._id, name: report.user.name ?? null, role: report.user.role ?? null }
        : null,
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
    resolvedAt: report.resolvedAt ?? null,
});

/** @returns {Promise<{items, total, page, limit, counts: {open, in_progress, resolved, closed}}>} */
export const listIssueReports = async ({ actor, query = {} }) => {
    const base = scopeFilter(actor);
    const search = asText(query.search).slice(0, 100);
    if (search) {
        const pattern = escapeRegex(search);
        base.$or = ["name", "email", "description"].map((field) => ({ [field]: { $regex: pattern, $options: "i" } }));
    }
    const filter = { ...base };
    const status = asText(query.status);
    if (status && status !== "all") {
        if (!ISSUE_STATUSES.includes(status)) throw validation(`status must be one of ${ISSUE_STATUSES.join(", ")}`, "status");
        filter.status = status;
    }
    const page = intParam(query.page, { min: 1, max: 10_000, fallback: 1 });
    const limit = intParam(query.limit, { min: 1, max: 100, fallback: 20 });

    const [total, reports, grouped] = await Promise.all([
        IssueReport.countDocuments(filter),
        IssueReport.find(filter)
            .sort({ createdAt: -1, _id: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .populate({ path: "user", select: "name role" })
            .lean(),
        IssueReport.aggregate([{ $match: base }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
    ]);
    const counts = Object.fromEntries(ISSUE_STATUSES.map((value) => [value, 0]));
    for (const row of grouped) if (Object.hasOwn(counts, row._id)) counts[row._id] = row.count;
    return { items: reports.map(reportView), total, page, limit, counts };
};

/** Triage: `{status?, note?}`. 404 outside the actor's scope. Notifies a signed-in reporter. */
export const updateIssueReport = async ({ actor, id, body = {} }) => {
    const input = body && typeof body === "object" ? body : {};
    const update = {};
    if (input.status !== undefined) {
        if (!ISSUE_STATUSES.includes(input.status)) throw validation(`status must be one of ${ISSUE_STATUSES.join(", ")}`, "status");
        update.status = input.status;
    }
    if (input.note !== undefined) {
        if (input.note !== null && typeof input.note !== "string") throw validation("note must be text", "note");
        const note = asText(input.note);
        if (note.length > ISSUE_LIMITS.note) throw validation(`note must be at most ${ISSUE_LIMITS.note} characters`, "note");
        update.note = note;
    }
    if (Object.keys(update).length === 0) throw validation("Provide a status or a note.");
    if (!isObjectId(String(id ?? ""))) throw fail(404, "Issue report not found", "NOT_FOUND");

    const report = await IssueReport.findOne({ _id: String(id), ...scopeFilter(actor) });
    if (!report) throw fail(404, "Issue report not found", "NOT_FOUND");

    const previousStatus = report.status;
    if (update.status !== undefined) {
        report.status = update.status;
        if (["resolved", "closed"].includes(update.status)) {
            if (!["resolved", "closed"].includes(previousStatus) || !report.resolvedAt) report.resolvedAt = new Date();
        } else {
            report.resolvedAt = undefined;
        }
    }
    if (update.note !== undefined) report.note = update.note;
    report.handledBy = actor._id;
    await report.save();

    if (report.user && update.status !== undefined && update.status !== previousStatus) {
        try {
            await notify(report.user, {
                type: "issue.updated",
                title: `Your issue report is now ${STATUS_LABELS[report.status]}`,
                body: report.note || "",
                data: { reportId: String(report._id), status: report.status },
                priority: "low",
            });
        } catch (error) {
            logAuthEvent("issue-reports", "status notification failed", { error: error?.message || String(error) }, "warn");
        }
    }

    await report.populate({ path: "user", select: "name role" });
    return reportView(report.toObject());
};
