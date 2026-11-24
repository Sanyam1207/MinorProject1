// Placement policy: resolve, save and classify (docs/contracts/PLACEMENTS.md §3.4, §6.3, §7.3).
import mongoose from "mongoose";
import { fail, isObjectId } from "../../../core/http.js";
import { DEFAULT_POLICY } from "../constants.js";
import { PlacementPolicy } from "../models/placement-policy.model.js";
import { academicYearFor, isValidAcademicYear } from "./academic-year.js";
import { round2 } from "./package.js";

const POLICY_FIELDS = Object.keys(DEFAULT_POLICY);

const asPlain = (doc) => (doc && typeof doc.toObject === "function" ? doc.toObject() : doc);

const toCollegeId = (value) => {
    if (value === null || value === undefined || value === "") return null;
    if (value instanceof mongoose.Types.ObjectId) return value;
    if (value?._id) return toCollegeId(value._id);
    return isObjectId(String(value)) ? new mongoose.Types.ObjectId(String(value)) : null;
};

/** The default policy object for a year (not stored). */
export const defaultPolicyFor = (academicYear) => ({
    _id: null,
    college: null,
    academicYear,
    ...DEFAULT_POLICY,
    isActive: true,
    isDefault: true,
    updatedAt: null,
    updatedBy: null,
});

/**
 * First match of: {college, year} → college's active policy → {null, year} → global active → defaults.
 * @returns {Promise<object>} a plain policy object (`isDefault:true` when nothing is stored)
 */
export const resolvePolicy = async (collegeId, academicYear = academicYearFor()) => {
    const college = toCollegeId(collegeId);
    const year = isValidAcademicYear(academicYear) ? academicYear : academicYearFor();
    if (college) {
        const exact = await PlacementPolicy.findOne({ college, academicYear: year }).lean();
        if (exact) return { ...exact, isDefault: false };
        const active = await PlacementPolicy.findOne({ college, isActive: true }).sort({ updatedAt: -1 }).lean();
        if (active) return { ...active, isDefault: false };
    }
    const globalExact = await PlacementPolicy.findOne({ college: null, academicYear: year }).lean();
    if (globalExact) return { ...globalExact, isDefault: false };
    const globalActive = await PlacementPolicy.findOne({ college: null, isActive: true }).sort({ updatedAt: -1 }).lean();
    if (globalActive) return { ...globalActive, isDefault: false };
    return defaultPolicyFor(year);
};

/** Memoising resolver for loops (one lookup per college/year pair). */
export const createPolicyCache = () => {
    const cache = new Map();
    return (collegeId, academicYear) => {
        const key = `${collegeId ? String(collegeId._id ?? collegeId) : "null"}|${academicYear}`;
        if (!cache.has(key)) cache.set(key, resolvePolicy(collegeId, academicYear));
        return cache.get(key);
    };
};

const invalid = (field, message) => fail(400, message, "VALIDATION", { field });

const boolField = (body, field, fallback) => {
    const value = body[field];
    if (value === undefined || value === null || value === "") return fallback;
    if (value === true || value === "true" || value === 1 || value === "1") return true;
    if (value === false || value === "false" || value === 0 || value === "0") return false;
    throw invalid(field, `${field} must be true or false`);
};

const numberField = (body, field, fallback, { min, max, integer = false }) => {
    const raw = body[field];
    if (raw === undefined || raw === null || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw invalid(field, `${field} must be a number`);
    if (integer && !Number.isInteger(value)) throw invalid(field, `${field} must be a whole number`);
    if (value < min || value > max) throw invalid(field, `${field} must be between ${min} and ${max}`);
    return value;
};

/** Validate the PolicyConfigPanel object (§3.4). Unknown keys, `_id` and `isDefault` are ignored. */
export const validatePolicyInput = (body = {}, base = DEFAULT_POLICY) => {
    const values = {
        enforceOneOffer: boolField(body, "enforceOneOffer", base.enforceOneOffer),
        allowDreamUpgrade: boolField(body, "allowDreamUpgrade", base.allowDreamUpgrade),
        dreamMultiplier: numberField(body, "dreamMultiplier", base.dreamMultiplier, { min: 1.1, max: 5 }),
        superDreamMultiplier: numberField(body, "superDreamMultiplier", base.superDreamMultiplier, { min: 1.5, max: 10 }),
        maxPendingOffers: numberField(body, "maxPendingOffers", base.maxPendingOffers, { min: 1, max: 10, integer: true }),
        offerExpiryDays: numberField(body, "offerExpiryDays", base.offerExpiryDays, { min: 1, max: 30, integer: true }),
    };
    if (values.superDreamMultiplier < values.dreamMultiplier) {
        throw invalid("superDreamMultiplier", "superDreamMultiplier must be at least dreamMultiplier");
    }
    return values;
};

/** POST/PUT /offers/policy (§6.3): upsert {college, academicYear}, activate it, deactivate the college's others. */
export const savePolicy = async (user, body = {}) => {
    const academicYear = body.academicYear === undefined || body.academicYear === null || body.academicYear === ""
        ? academicYearFor()
        : String(body.academicYear).trim();
    if (!isValidAcademicYear(academicYear)) throw invalid("academicYear", "academicYear must look like 2026-27");
    let college = toCollegeId(user.college);
    if (user.role === "admin") {
        if (body.collegeId !== undefined && body.collegeId !== null && body.collegeId !== "") {
            if (!isObjectId(String(body.collegeId))) throw invalid("collegeId", "collegeId must be a valid id");
            college = toCollegeId(body.collegeId);
        } else college = null;
    }
    const values = validatePolicyInput(body);
    const saved = await PlacementPolicy.findOneAndUpdate(
        { college, academicYear },
        { $set: { ...values, isActive: true, updatedBy: user._id } },
        { upsert: true, returnDocument: "after", runValidators: true, setDefaultsOnInsert: true },
    );
    await PlacementPolicy.updateMany({ college, _id: { $ne: saved._id } }, { $set: { isActive: false } });
    return { ...asPlain(saved), isDefault: false };
};

/**
 * normal | dream | super-dream relative to the best package the student already holds.
 */
export const classifyOffer = (packageLpa, best, policy = DEFAULT_POLICY) => {
    if (best === null || best === undefined || !Number.isFinite(Number(best))) return "normal";
    const value = Number(packageLpa);
    if (value >= round2(best * (policy.superDreamMultiplier ?? DEFAULT_POLICY.superDreamMultiplier))) return "super-dream";
    if (value >= round2(best * (policy.dreamMultiplier ?? DEFAULT_POLICY.dreamMultiplier))) return "dream";
    return "normal";
};

export const pickPolicyValues = (policy) => Object.fromEntries(POLICY_FIELDS.map((field) => [field, policy?.[field] ?? DEFAULT_POLICY[field]]));
