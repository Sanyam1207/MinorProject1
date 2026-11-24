// Recruiting company. Campus drives (Job) and recruiter accounts (User.company) reference it.
// Drives find-or-create companies by case-insensitive exact name (placements drive.service.js).
import mongoose, { Schema } from "mongoose";

const CompanySchema = new Schema({
    name: { type: String, required: true, trim: true, maxlength: 200 },
    logo: { type: String, trim: true, maxlength: 500 },
    website: { type: String, trim: true, maxlength: 500 },
}, {
    timestamps: true,
});

CompanySchema.index({ name: 1 });

export const Company = mongoose.models.Company || mongoose.model("Company", CompanySchema, "companies");
