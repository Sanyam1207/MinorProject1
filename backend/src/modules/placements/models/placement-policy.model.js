// Per-college, per-academic-year placement policy (docs/contracts/PLACEMENTS.md §3.4).
// Field names follow PolicyConfigPanel.jsx. Collection `placement_policies`.
import mongoose, { Schema } from "mongoose";
import { DEFAULT_POLICY } from "../constants.js";
import { isValidAcademicYear } from "../services/academic-year.js";

const PlacementPolicySchema = new Schema({
    college: { type: Schema.Types.ObjectId, ref: "College", default: null },
    academicYear: {
        type: String,
        required: true,
        validate: { validator: isValidAcademicYear, message: "academicYear must look like 2026-27" },
    },
    enforceOneOffer: { type: Boolean, default: DEFAULT_POLICY.enforceOneOffer },
    allowDreamUpgrade: { type: Boolean, default: DEFAULT_POLICY.allowDreamUpgrade },
    dreamMultiplier: { type: Number, default: DEFAULT_POLICY.dreamMultiplier, min: 1.1, max: 5 },
    superDreamMultiplier: { type: Number, default: DEFAULT_POLICY.superDreamMultiplier, min: 1.5, max: 10 },
    maxPendingOffers: { type: Number, default: DEFAULT_POLICY.maxPendingOffers, min: 1, max: 10 },
    offerExpiryDays: { type: Number, default: DEFAULT_POLICY.offerExpiryDays, min: 1, max: 30 },
    isActive: { type: Boolean, default: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
}, { timestamps: true });

PlacementPolicySchema.index({ college: 1, academicYear: 1 }, { unique: true });

export const PlacementPolicy = mongoose.models.PlacementPolicy
    || mongoose.model("PlacementPolicy", PlacementPolicySchema, "placement_policies");
