import mongoose, { Schema } from "mongoose";

const scoreSchema = new Schema({
    score: { type: Number, min: 0, max: 10, default: 0 },
    technicalSkills: { type: Number, min: 0, max: 10 },
    problemSolving: { type: Number, min: 0, max: 10 },
    clarity: { type: Number, min: 0, max: 10 },
    answerStructure: { type: Number, min: 0, max: 10 },
    fillers: { type: Number, min: 0, max: 10 },
    conciseness: { type: Number, min: 0, max: 10 },
}, { _id: false });

const topicScoreSchema = new Schema({
    topic: { type: String, required: true, trim: true, maxlength: 200 },
    score: { type: Number, min: 0, max: 10, default: 0 },
}, { _id: false });

const technicalFeedbackSchema = new Schema({
    technicalSkills: { type: [String], default: [] },
    problemSolving: { type: [String], default: [] },
}, { _id: false });

const communicationFeedbackSchema = new Schema({
    clarity: { type: [String], default: [] },
    answerStructure: { type: [String], default: [] },
    fillers: { type: [String], default: [] },
    conciseness: { type: [String], default: [] },
}, { _id: false });

const topicFeedbackSchema = new Schema({
    topic: { type: String, required: true, trim: true, maxlength: 200 },
    score: { type: Number, min: 0, max: 10, default: 0 },
    points: { type: [String], default: [] },
}, { _id: false });

const feedbackSideSchema = new Schema({
    technical: { type: technicalFeedbackSchema, default: () => ({}) },
    communication: { type: communicationFeedbackSchema, default: () => ({}) },
    topics: { type: [topicFeedbackSchema], default: [] },
}, { _id: false });

const interviewSchema = new Schema({
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    student: { type: Schema.Types.ObjectId, ref: "Student", required: true, index: true },
    requestId: { type: String, required: true, trim: true, maxlength: 100 },
    sessionId: { type: String, required: true, trim: true, maxlength: 100, index: true },
    source: { type: String, enum: ["profile", "job"], required: true },
    candidateName: { type: String, required: true, trim: true, maxlength: 200 },
    role: { type: String, required: true, trim: true, maxlength: 500 },
    durationMinutes: { type: Number, min: 0, default: 0 },
    questionsAsked: { type: Number, min: 0, default: 0 },
    endedReason: { type: String, default: "", trim: true, maxlength: 200 },
    generatedAt: { type: Date, required: true },
    inputType: { type: String, enum: ["voice", "text", "mixed"], default: "text" },
    targetJob: { type: Schema.Types.Mixed, default: null },
    overallScore: { type: Number, required: true, min: 0, max: 10 },
    scores: {
        technical: { type: scoreSchema, default: () => ({}) },
        communication: { type: scoreSchema, default: () => ({}) },
    },
    topics: { type: [topicScoreSchema], default: [] },
    positives: { type: feedbackSideSchema, default: () => ({}) },
    negatives: { type: feedbackSideSchema, default: () => ({}) },
    skillGaps: { type: [String], default: [] },
    summary: { type: String, default: "", maxlength: 10000 },
    formattedReport: { type: String, default: "", maxlength: 50000 },
    rawReport: { type: Schema.Types.Mixed, required: true },
    reportVersion: { type: Number, default: 1, min: 1 },
    recommendationPlan: { type: Schema.Types.Mixed, default: null },
    recommendationsGeneratedAt: { type: Date, default: null },
}, { timestamps: true });

interviewSchema.index({ owner: 1, requestId: 1 }, { unique: true });
interviewSchema.index({ owner: 1, createdAt: -1 });
interviewSchema.index({ owner: 1, overallScore: -1 });

export const Interview = mongoose.models.Interview || mongoose.model("Interview", interviewSchema);
