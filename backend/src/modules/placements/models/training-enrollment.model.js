// Training registration (docs/contracts/PLACEMENTS.md §3.6). Collection `training_enrollments`.
import mongoose, { Schema } from "mongoose";
import { ATTENDANCE_METHODS, COMPLETION_STATUSES, ENROLLMENT_STATUSES } from "../constants.js";
import { clock } from "../utils/dates.js";

const AttendanceSchema = new Schema({
    sessionIndex: { type: Number, required: true, min: 0 },
    date: { type: Date },
    markedAt: { type: Date, default: () => clock.now() },
    markedBy: { type: Schema.Types.ObjectId, ref: "User" },
    method: { type: String, enum: ATTENDANCE_METHODS, default: "manual" },
}, { _id: false });

const TrainingEnrollmentSchema = new Schema({
    program: { type: Schema.Types.ObjectId, ref: "TrainingProgram", required: true, index: true },
    student: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    status: { type: String, enum: ENROLLMENT_STATUSES, default: "registered" },
    completionStatus: { type: String, enum: COMPLETION_STATUSES, default: "enrolled" },
    attendance: { type: [AttendanceSchema], default: [] },
    certificateUrl: { type: String, trim: true, maxlength: 500, default: null },
    registeredAt: { type: Date, default: () => clock.now() },
}, { timestamps: true });

TrainingEnrollmentSchema.index({ program: 1, student: 1 }, { unique: true });

export const TrainingEnrollment = mongoose.models.TrainingEnrollment
    || mongoose.model("TrainingEnrollment", TrainingEnrollmentSchema, "training_enrollments");
