import mongoose, { Schema } from "mongoose";

export const ALUMNI_REQUEST_TYPES = [
    "career-guidance",
    "resume-review",
    "project-review",
    "mock-interview",
    "company-insights",
    "higher-education",
];

const alumniProfileSchema = new Schema({
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    college: { type: Schema.Types.ObjectId, ref: "College", required: true, index: true },
    name: { type: String, required: true, trim: true },
    branch: { type: String, required: true, trim: true },
    degree: { type: String, default: "B.Tech", trim: true },
    graduationYear: { type: Number, required: true },
    company: { type: String, required: true, trim: true },
    currentRole: { type: String, required: true, trim: true },
    location: { type: String, default: "", trim: true },
    bio: { type: String, default: "", maxlength: 2000 },
    skills: { type: [String], default: [] },
    mentoringTopics: { type: [String], default: [] },
    languages: { type: [String], default: ["English"] },
    requestTypes: [{ type: String, enum: ALUMNI_REQUEST_TYPES }],
    availability: { type: String, default: "", maxlength: 500 },
    capacity: { type: Number, default: 3, min: 1, max: 20 },
    acceptingRequests: { type: Boolean, default: true },
    onboardingComplete: { type: Boolean, default: false },
    verificationStatus: { type: String, enum: ["unverified"], default: "unverified" },
    isDemo: { type: Boolean, default: false },
}, { timestamps: true });

export const AlumniProfile = mongoose.model("AlumniProfile", alumniProfileSchema);

const alumniConnectionSchema = new Schema({
    student: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    alumni: { type: Schema.Types.ObjectId, ref: "AlumniProfile", required: true, index: true },
    alumniUser: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    requestType: { type: String, enum: ALUMNI_REQUEST_TYPES, required: true },
    message: { type: String, required: true, maxlength: 3000 },
    status: { type: String, enum: ["pending", "accepted", "declined", "closed"], default: "pending" },
    selectedJob: { type: Schema.Types.Mixed, default: null },
    sharedResume: { type: String, default: "", maxlength: 100000 },
}, { timestamps: true });
alumniConnectionSchema.index({ student: 1, alumni: 1 }, { unique: true });

export const AlumniConnection = mongoose.model("AlumniConnection", alumniConnectionSchema);

const mentorshipMessageSchema = new Schema({
    connection: { type: Schema.Types.ObjectId, ref: "AlumniConnection", required: true, index: true },
    sender: { type: Schema.Types.ObjectId, ref: "User", required: true },
    text: { type: String, required: true, maxlength: 3000 },
    type: { type: String, enum: ["text", "resume-share"], default: "text" },
    resumeVersion: { type: Schema.Types.ObjectId, ref: "Resume", default: null },
    resumeSnapshot: {
        kind: String,
        title: String,
        version: Number,
        targetJob: Schema.Types.Mixed,
    },
}, { timestamps: true });

export const MentorshipMessage = mongoose.model("MentorshipMessage", mentorshipMessageSchema);
