// Role, college and company filters (docs/contracts/PLACEMENTS.md §1).
// A record outside the caller's scope answers 404 NOT_FOUND (never 403) so ids do not leak.
import mongoose from "mongoose";
import { fail, isObjectId } from "../../../core/http.js";
import { Application } from "../models/application.model.js";

const toObjectId = (value) => (value instanceof mongoose.Types.ObjectId ? value : new mongoose.Types.ObjectId(String(value)));

/** College filter. Records with `college: null` are global and visible to every college. */
export const collegeScope = (user, { collegeId } = {}) => {
    if (user?.role === "admin") {
        if (collegeId && isObjectId(String(collegeId))) return { college: toObjectId(collegeId) };
        return {};
    }
    if (user?.college) return { college: { $in: [toObjectId(user.college), null] } };
    return { college: null };
};

/** Recruiter filter; throws 403 COMPANY_NOT_LINKED for a recruiter without a company. */
export const companyScope = (user, options = {}) => {
    if (!user?.company) throw fail(403, "Your recruiter account is not linked to a company yet. Ask the placement office.", "COMPANY_NOT_LINKED");
    return { company: toObjectId(user.company), ...collegeScope(user, options) };
};

/**
 * Drive visibility. Pure: students need `appliedJobIds` (see loadAppliedJobIds / resolveJobScope).
 */
export const jobScope = (user, { appliedJobIds = [], collegeId } = {}) => {
    const role = user?.role;
    if (role === "tpo" || role === "admin") return collegeScope(user, { collegeId });
    if (role === "company") return companyScope(user);
    if (role === "student") {
        const ids = (appliedJobIds || []).map(toObjectId);
        return {
            ...collegeScope(user),
            $or: [{ status: "active" }, ...(ids.length ? [{ _id: { $in: ids }, status: "closed" }] : [])],
        };
    }
    return { ...collegeScope(user), status: "active" };
};

/** Jobs the student has an application for (any status). */
export const loadAppliedJobIds = async (studentId) => (studentId ? Application.distinct("job", { student: studentId }) : []);

/** jobScope with appliedJobIds loaded for students. */
export const resolveJobScope = async (user, options = {}) => {
    if (user?.role !== "student") return jobScope(user, options);
    return jobScope(user, { ...options, appliedJobIds: await loadAppliedJobIds(user._id) });
};

const recordScope = (user, options = {}) => {
    const role = user?.role;
    if (role === "student") return { student: toObjectId(user._id) };
    if (role === "tpo" || role === "admin") return collegeScope(user, options);
    if (role === "company") return companyScope(user, options);
    throw fail(403, "Your role cannot view placement applications or offers", "FORBIDDEN");
};

export const applicationScope = (user, options) => recordScope(user, options);
export const offerScope = (user, options) => recordScope(user, options);

/** Combine filters without key collisions (`$or` etc.). */
export const andFilters = (...filters) => {
    const parts = filters.filter((filter) => filter && Object.keys(filter).length > 0);
    if (parts.length === 0) return {};
    if (parts.length === 1) return parts[0];
    return { $and: parts };
};

export const notFound = (noun = "Record") => fail(404, `${noun} not found`, "NOT_FOUND");
