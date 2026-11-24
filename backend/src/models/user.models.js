import mongoose, { Schema } from "mongoose";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "crypto";

const UserSchema = new Schema({
    name: {
        type: String,
        required: true,
    },
    email: {
        type: String,
        required: true,
        unique: true,
        index: true,
        lowercase: true,
        trim: true,
    },
    role: {
        type: String,
        enum: ["student", "teacher", "tpo", "company", "admin", "alumni"],
        default: "student",
    },
    profile: {
        type: String,
        required: false,
    },
    password: {
        type: String,
        required: false,
    },
    authProvider: {
        type: String,
        enum: ["local", "google"],
        default: "local",
    },
    googleId: {
        type: String,
        required: false,
    },
    gmailConnection: {
        type: {
            connectedEmail: String,
            connectedAt: Date,
            scope: String,
        },
        required: false,
    },
    gmailRefreshTokenEncrypted: {
        type: String,
        required: false,
        select: false,
    },
    refreshToken: {
        type: String,
        required: false,
    },
    passwordResetToken: {
        type: String,
        required: false,
    },
    passwordResetExpiry: {
        type: Date,
        required: false,
    }
    ,
    student: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Student",
        required: false
    },
    branch: {
        type: String,
        required: false,
    },
    collegeName: {
        type: String,
        required: false,
    },
    passingYear: {
        type: String,
        required: false,
    },
    ggsipuLinked: {
        type: Boolean,
        default: false,
    },
    ggsipuEnrollment: {
        type: String,
        required: false,
        unique: true,
        sparse: true,
    },
    ggsipuProfile: {
        type: mongoose.Schema.Types.Mixed,
        required: false,
    },
    ggsipuAcademicRecord: {
        type: mongoose.Schema.Types.Mixed,
        required: false,
    },
    ggsipuLastSyncedAt: {
        type: Date,
        required: false,
    },
    company: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Company",
        required: false
    },
    TPO: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Tpo",
        required: false,
    },
    college: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "College",
        required: false,
    },
    cgpa: {
        type: Number,
        required: false,
    },
    skills: {
        type: [String],
        default: [],
    },
    projects: {
        type: [{
            title: String,
            description: String,
            skills: [String],
            link: String,
        }],
        default: [],
    },
    certifications: {
        type: [{
            name: String,
            issuer: String,
            date: String,
            credentialUrl: String,
        }],
        default: [],
    },
    experience: {
        type: [{
            title: String,
            company: String,
            duration: String,
            description: String,
        }],
        default: [],
    },
    careerPreferences: {
        type: mongoose.Schema.Types.Mixed,
        required: false,
        default: {
            preferredRoles: [],
            preferredLocations: [],
            expectedSalary: "",
        }
    },
    socialLinks: {
        type: mongoose.Schema.Types.Mixed,
        required: false,
        default: {
            github: "",
            linkedin: "",
            leetcode: "",
            portfolio: "",
        }
    },
    // ── Academic placement used by attendance auto-enrolment ──
    rollNumber: { type: String, trim: true },
    section: { type: String, trim: true, uppercase: true },
    semester: { type: Number, min: 1, max: 12 },
    // ── Trusted academic record used by placement eligibility (PLACEMENTS §3.7) ──
    activeBacklogs: { type: Number, min: 0, max: 50 },
    tenthPercentage: { type: Number, min: 0, max: 100 },
    twelfthPercentage: { type: Number, min: 0, max: 100 },
    // ── Faculty (role "teacher") ──
    department: { type: String, trim: true },
    designation: { type: String, trim: true },
    employeeId: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
    // ── Notifications (see docs/contracts/NOTIFICATIONS.md) ──
    notificationPreferences: {
        email: { type: Boolean, default: false },
        push: { type: Boolean, default: true },
        mutedTypes: { type: [String], default: [] },
    },
    // ── Bring-your-own LLM keys (ported from Matchy). Encrypted at rest and
    //    excluded from queries unless explicitly selected with "+llmCredentials". ──
    llmCredentials: {
        type: [{
            label: { type: String, trim: true, maxlength: 80 },
            provider: { type: String, enum: ["openai", "anthropic", "google", "xai"], required: true },
            encryptedApiKey: { type: String, required: true },
            model: { type: String, trim: true },
            // Last characters of the key, shown masked in the UI (RESUME-BYOK).
            keyHint: { type: String, maxlength: 40 },
            updatedAt: { type: Date, default: Date.now },
        }],
        default: [],
        select: false,
    },

},
    {
        timestamps: true
    })

const SENSITIVE_USER_FIELDS = [
    "password",
    "refreshToken",
    "passwordResetToken",
    "passwordResetExpiry",
    "gmailRefreshTokenEncrypted",
    "llmCredentials",
];

const stripSensitiveFields = (_doc, ret) => {
    for (const field of SENSITIVE_USER_FIELDS) delete ret[field];
    return ret;
};

UserSchema.set("toJSON", { transform: stripSensitiveFields });

UserSchema.index({ role: 1, branch: 1, passingYear: 1, section: 1 });

UserSchema.pre("save", async function () {
    if (!this.isModified("password")) return;
    this.password = await bcrypt.hash(this.password, 10);
})

UserSchema.methods.isPasswordCorrect = async function (password) {
    return await bcrypt.compare(password, this.password);
}

UserSchema.methods.generateAccessToken = function () {
    return jwt.sign(
        {
            _id: this._id,
            email: this.email,
            name: this.name,
            role: this.role,
        },
        process.env.ACCESS_TOKEN_SECRET,
        {
            expiresIn: process.env.ACCESS_TOKEN_EXPIRY,
        }
    )
}

UserSchema.methods.generateRefreshToken = function () {
    return jwt.sign(
        {
            _id: this._id,
        },
        process.env.REFRESH_TOKEN_SECRET,
        {
            expiresIn: process.env.REFRESH_TOKEN_EXPIRY,
        }
    )
}

UserSchema.methods.generatePasswordResetToken = function () {
    const resetToken = crypto.randomBytes(32).toString("hex");
    this.passwordResetToken = crypto.createHash("sha256").update(resetToken).digest("hex");
    this.passwordResetExpiry = Date.now() + 15 * 60 * 1000;
    return resetToken;
}

export const User = mongoose.model("User", UserSchema);
