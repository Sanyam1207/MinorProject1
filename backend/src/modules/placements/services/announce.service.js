// Placement announcements (docs/contracts/PLACEMENTS.md §6.5, tool `announce`).
import mongoose from "mongoose";
import { fail } from "../../../core/http.js";
import { User } from "../../../models/user.models.js";
import { placementsConfig } from "../config.js";
import { ANNOUNCE_ROLES, isStaff } from "../constants.js";
import { bool, list, oneOf, str } from "../utils/input.js";
import * as events from "./events.js";
import { branchMatches } from "./branches.js";

const invalid = (field, message) => fail(400, message, "VALIDATION", { field });

const toList = (value, field) => {
    if (value === undefined || value === null || value === "") return [];
    return list(Array.isArray(value) ? value.map((item) => (item == null ? item : String(item))) : String(value), { maxItems: 30, maxLen: 100, field });
};

/** Normalised audience: {roles, branch: string[], passingYear: string[]}. */
export const normalizeAudience = (audience = {}) => {
    if (audience !== undefined && audience !== null && (typeof audience !== "object" || Array.isArray(audience))) {
        throw invalid("audience", "audience must be an object");
    }
    const value = audience || {};
    const rawRoles = toList(value.roles, "audience.roles");
    const roles = rawRoles.length ? rawRoles.map((role) => oneOf(role, ANNOUNCE_ROLES, { field: "audience.roles" })) : ["student"];
    return {
        roles: [...new Set(roles)],
        branch: toList(value.branch, "audience.branch"),
        passingYear: toList(value.passingYear, "audience.passingYear"),
    };
};

const audienceCollege = (user, collegeId) => {
    if (user.role === "admin") {
        return collegeId && mongoose.isValidObjectId(collegeId) ? { college: new mongoose.Types.ObjectId(String(collegeId)) } : {};
    }
    return { college: user.college ?? null };
};

/**
 * Users the announcement would reach (never the sender).
 * @returns {Promise<{recipients: string[], audience: object}>}
 * @throws 400 NO_RECIPIENTS / TOO_MANY_RECIPIENTS
 */
export const resolveAnnouncementAudience = async (user, rawAudience, { collegeId } = {}) => {
    if (!isStaff(user)) throw fail(403, "Only the placement office can send announcements", "FORBIDDEN");
    const audience = normalizeAudience(rawAudience);
    const filter = { role: { $in: audience.roles }, isActive: { $ne: false }, _id: { $ne: user._id }, ...audienceCollege(user, collegeId) };
    if (audience.passingYear.length) filter.passingYear = { $in: audience.passingYear };
    let users = await User.find(filter).select("branch").lean();
    if (audience.branch.length) users = users.filter((candidate) => branchMatches(candidate.branch, audience.branch));
    if (users.length === 0) throw fail(400, "No users match this audience", "NO_RECIPIENTS");
    if (users.length > placementsConfig.announceMaxRecipients) {
        throw fail(400, `This audience has ${users.length} users; the limit is ${placementsConfig.announceMaxRecipients}`, "TOO_MANY_RECIPIENTS");
    }
    return { recipients: users.map((candidate) => String(candidate._id)), audience };
};

export const normalizeAnnouncement = (body = {}) => ({
    title: str(body.title, { field: "title", max: 140, required: true }),
    body: str(body.body, { field: "body", max: 1000, required: true }),
    email: body.email === undefined ? true : bool(body.email),
});

/** POST /placements/announcements → {recipients}. */
export const sendAnnouncement = async (user, body = {}) => {
    const message = normalizeAnnouncement(body);
    const { recipients } = await resolveAnnouncementAudience(user, body.audience, { collegeId: body.collegeId });
    events.announcement(recipients, message);
    return { recipients: recipients.length };
};
