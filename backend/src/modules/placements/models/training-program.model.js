// Training program (docs/contracts/PLACEMENTS.md §3.5). Collection `training_programs`.
// Field names follow TrainingHub.jsx and TrainingScheduler.jsx.
import mongoose, { Schema } from "mongoose";
import { DELIVERY_MODES, PROGRAM_STATUSES, TRAINING_TYPES } from "../constants.js";

const SessionSchema = new Schema({
    date: { type: Date, required: true },
    time: { type: String, trim: true, maxlength: 40, default: "" },
    venue: { type: String, trim: true, maxlength: 200, default: "TBA" },
    topic: { type: String, trim: true, maxlength: 200, default: "" },
    durationMinutes: { type: Number, min: 15, max: 600 },
});

const TrainingProgramSchema = new Schema({
    college: { type: Schema.Types.ObjectId, ref: "College", default: null, index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, maxlength: 5000, default: "" },
    type: { type: String, enum: TRAINING_TYPES, default: "other" },
    instructor: { type: String, trim: true, maxlength: 120, default: "" },
    deliveryMode: { type: String, enum: DELIVERY_MODES, default: "offline" },
    capacity: {
        type: Number,
        required: true,
        min: 1,
        validate: { validator: Number.isInteger, message: "capacity must be a whole number" },
    },
    enrolledCount: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: PROGRAM_STATUSES, default: "upcoming" },
    schedule: {
        type: [SessionSchema],
        validate: {
            validator: (sessions) => Array.isArray(sessions) && sessions.length >= 1 && sessions.length <= 60,
            message: "schedule needs between 1 and 60 sessions",
        },
    },
    registrationDeadline: { type: Date, default: null },
    audience: {
        branches: { type: [String], default: [] },
        graduationYears: { type: [String], default: [] },
        minCgpa: { type: Number, min: 0, max: 10, default: null },
    },
    cancelReason: { type: String, trim: true, maxlength: 500 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
}, { timestamps: true });

TrainingProgramSchema.index({ college: 1, status: 1, "schedule.date": 1 });

// schedule[0] is always the first session.
TrainingProgramSchema.pre("validate", function sortSchedule() {
    if (Array.isArray(this.schedule) && this.schedule.length > 1) {
        const sorted = [...this.schedule].sort((a, b) => new Date(a.date) - new Date(b.date));
        const changed = sorted.some((session, index) => session !== this.schedule[index]);
        if (changed) this.schedule = sorted.map((session) => (typeof session.toObject === "function" ? session.toObject() : session));
    }
});

export const TrainingProgram = mongoose.models.TrainingProgram
    || mongoose.model("TrainingProgram", TrainingProgramSchema, "training_programs");
