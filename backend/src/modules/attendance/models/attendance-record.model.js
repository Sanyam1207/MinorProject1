// AttendanceRecord (`attendance_records`): one per (session, student).
import mongoose, { Schema } from "mongoose";
import { RECORD_METHODS, RECORD_STATUSES } from "../config.js";

const { ObjectId } = Schema.Types;

const attendanceRecordSchema = new Schema({
    session: { type: ObjectId, ref: "ClassSession", required: true },
    course: { type: ObjectId, ref: "Course", required: true, index: true },
    student: { type: ObjectId, ref: "User", required: true, index: true },
    status: { type: String, enum: RECORD_STATUSES, required: true },
    method: { type: String, enum: RECORD_METHODS, required: true },
    markedAt: { type: Date, default: Date.now },
    markedBy: { type: ObjectId, ref: "User" },
    qrVersion: { type: Number },
    // HMAC-SHA256(deviceId, ATTENDANCE_DEVICE_SECRET); the raw id is never stored.
    deviceHash: { type: String },
    geo: {
        lat: { type: Number },
        lng: { type: Number },
        accuracy: { type: Number },
        distanceMeters: { type: Number },
    },
    flags: { type: [String], default: [] },
    note: { type: String, trim: true, maxlength: 300 },
}, { timestamps: true, collection: "attendance_records" });

attendanceRecordSchema.index({ session: 1, student: 1 }, { unique: true });
// One phone marks one student per session (QR scans only).
attendanceRecordSchema.index(
    { session: 1, deviceHash: 1 },
    { unique: true, partialFilterExpression: { method: "qr", deviceHash: { $type: "string" } } },
);

export const AttendanceRecord = mongoose.models.AttendanceRecord || mongoose.model("AttendanceRecord", attendanceRecordSchema);
