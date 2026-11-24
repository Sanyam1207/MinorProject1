// Placement offer (docs/contracts/PLACEMENTS.md §3.3). Collection `offers`.
// Field names follow StudentOffers.jsx and OfferManagement.jsx.
import mongoose, { Schema } from "mongoose";
import { OFFER_STATUSES, OFFER_TYPES } from "../constants.js";
import { academicYearFor } from "../services/academic-year.js";
import { clock } from "../utils/dates.js";

const HistorySchema = new Schema({
    status: { type: String, enum: OFFER_STATUSES, required: true },
    changedAt: { type: Date, default: () => clock.now() },
    by: { type: Schema.Types.ObjectId, ref: "User", default: null },
    byRole: { type: String, default: "" },
    byName: { type: String, default: "" },
    note: { type: String, maxlength: 600, default: "" },
}, { _id: false });

const OfferSchema = new Schema({
    student: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    application: { type: Schema.Types.ObjectId, ref: "Application", default: null, index: true },
    job: { type: Schema.Types.ObjectId, ref: "Job", default: null },
    company: { type: Schema.Types.ObjectId, ref: "Company", default: null, index: true },
    college: { type: Schema.Types.ObjectId, ref: "College", default: null, index: true },
    companyName: { type: String, required: true, trim: true, maxlength: 200 },
    roleTitle: { type: String, required: true, trim: true, maxlength: 200 },
    packageLpa: {
        type: Number,
        required: true,
        max: 500,
        validate: { validator: (value) => value > 0, message: "packageLpa must be greater than 0" },
    },
    ctcText: { type: String, trim: true, maxlength: 100 },
    offerType: { type: String, enum: OFFER_TYPES, default: "normal" },
    status: { type: String, enum: OFFER_STATUSES, default: "extended", index: true },
    expiresAt: { type: Date, required: true },
    joiningDate: { type: Date, default: null },
    location: { type: String, trim: true, maxlength: 200, default: "" },
    offerLetterUrl: { type: String, trim: true, maxlength: 500 },
    academicYear: { type: String, required: true, index: true },
    statusHistory: { type: [HistorySchema], default: [] },
    tpoOverride: { type: Boolean, default: false },
    responseReason: { type: String, trim: true, maxlength: 500 },
    respondedAt: { type: Date, default: null },
    placedAt: { type: Date, default: null },
    reminderSentAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    createdByRole: { type: String },
}, { timestamps: true });

OfferSchema.index({ student: 1, status: 1 });
OfferSchema.index({ college: 1, academicYear: 1, status: 1 });
OfferSchema.index({ company: 1, status: 1 });
OfferSchema.index({ status: 1, expiresAt: 1 });

OfferSchema.pre("validate", function fillDerivedFields() {
    if (!this.academicYear) this.academicYear = academicYearFor(this.createdAt ?? clock.now());
    if (!Array.isArray(this.statusHistory) || this.statusHistory.length === 0) {
        this.statusHistory = [{ status: this.status || "extended", changedAt: clock.now(), byRole: "system" }];
    }
});

export const Offer = mongoose.models.Offer || mongoose.model("Offer", OfferSchema, "offers");
