import mongoose, { Schema } from "mongoose";

// A college (tenant). Students self-register only with an email on `domain`.
// `branches` and `departments` are canonicalised with utils/branch.js
// canonicalBranch() on every API write (docs/contracts/AUTH-FACULTY.md §2.3).
const CollegeSchema = new Schema({
    name: {
        type: String,
        trim: true,
    },
    domain: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true,
    },
    branches: {
        type: [String],
        default: [],
    },
    departments: {
        type: [String],
        default: [],
    },
    // The single TPO slot (claimed atomically on TPO bootstrap or first login).
    tpo: {
        type: Schema.Types.ObjectId,
        ref: "User",
        default: null,
    },
    // Legacy, unused.
    tpos: [{
        type: Schema.Types.ObjectId,
        ref: "TPO",
    }],
}, {
    timestamps: true,
});

export const College = mongoose.models.College || mongoose.model("College", CollegeSchema);
