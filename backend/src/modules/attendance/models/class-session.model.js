// ClassSession (`class_sessions`): one scheduled class. While `live` it carries
// the rotating single-use QR token (`qr.nonce`, never selected by default).
import mongoose, { Schema } from "mongoose";
import { ACTIVE_SESSION_STATUSES, SESSION_MODES, SESSION_SOURCES, SESSION_STATUSES } from "../config.js";

const { ObjectId } = Schema.Types;

const classSessionSchema = new Schema({
    course: { type: ObjectId, ref: "Course", required: true, index: true },
    teacher: { type: ObjectId, ref: "User", required: true, index: true },
    topic: { type: String, trim: true, default: "", maxlength: 200 },
    room: { type: String, trim: true, maxlength: 60 },
    mode: { type: String, enum: SESSION_MODES, default: "offline" },
    startsAt: { type: Date, required: true },
    endsAt: {
        type: Date,
        required: true,
        validate: {
            validator(value) {
                return !this.startsAt || !value || value.getTime() > this.startsAt.getTime();
            },
            message: "endsAt must be after startsAt",
        },
    },
    status: { type: String, enum: SESSION_STATUSES, default: "scheduled" },
    source: { type: String, enum: SESSION_SOURCES, default: "manual" },
    // Original weekly slot of a timetable session; kept when it is rescheduled so
    // materialisation never re-creates a class that was moved.
    slotStartsAt: { type: Date },
    cancelReason: { type: String, trim: true, maxlength: 300 },
    cancelledAt: { type: Date },
    liveStartedAt: { type: Date },
    endedAt: { type: Date },
    reminderSentAt: { type: Date },
    qr: {
        nonce: { type: String, select: false },
        version: { type: Number, default: 0 },
        issuedAt: { type: Date },
        expiresAt: { type: Date },
        rotationSeconds: { type: Number },
    },
    geo: {
        lat: { type: Number, min: -90, max: 90 },
        lng: { type: Number, min: -180, max: 180 },
        accuracy: { type: Number, min: 0 },
        radiusMeters: { type: Number, min: 0 },
    },
    stats: {
        present: { type: Number, default: 0 },
        late: { type: Number, default: 0 },
        absent: { type: Number, default: 0 },
        excused: { type: Number, default: 0 },
        enrolled: { type: Number, default: 0 },
    },
}, { timestamps: true, collection: "class_sessions" });

// One non-cancelled session per course per start time → timetable materialisation is idempotent.
classSessionSchema.index(
    { course: 1, startsAt: 1 },
    { unique: true, partialFilterExpression: { status: { $in: [...ACTIVE_SESSION_STATUSES] } } },
);
classSessionSchema.index({ teacher: 1, startsAt: 1 });
classSessionSchema.index({ status: 1, endsAt: 1 });
classSessionSchema.index({ course: 1, slotStartsAt: 1 }, { partialFilterExpression: { slotStartsAt: { $exists: true } } });

export const ClassSession = mongoose.models.ClassSession || mongoose.model("ClassSession", classSessionSchema);
