import { Interview } from "../models/interview.model.js";

const text = (value, maxLength = 3000) => String(value || "").trim().slice(0, maxLength);
const score = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.min(10, parsed)) : 0;
};
const lines = (value, limit = 20) => Array.isArray(value)
    ? value.map((item) => text(item)).filter(Boolean).slice(0, limit)
    : [];

const mapScores = (report) => ({
    technical: {
        score: score(report.scores?.technical?.score),
        technicalSkills: score(report.scores?.technical?.technical_skills),
        problemSolving: score(report.scores?.technical?.problem_solving),
    },
    communication: {
        score: score(report.scores?.communication?.score),
        clarity: score(report.scores?.communication?.clarity),
        answerStructure: score(report.scores?.communication?.answer_structure),
        fillers: score(report.scores?.communication?.fillers),
        conciseness: score(report.scores?.communication?.conciseness),
    },
});

const mapFeedbackSide = (side = {}) => ({
    technical: {
        technicalSkills: lines(side.technical?.technical_skills),
        problemSolving: lines(side.technical?.problem_solving),
    },
    communication: {
        clarity: lines(side.communication?.clarity),
        answerStructure: lines(side.communication?.answer_structure),
        fillers: lines(side.communication?.fillers),
        conciseness: lines(side.communication?.conciseness),
    },
    topics: Array.isArray(side.topics) ? side.topics.slice(0, 20).map((topic) => ({
        topic: text(topic?.topic, 200) || "General",
        score: score(topic?.score),
        points: lines(topic?.points),
    })) : [],
});

const validDate = (value) => {
    const parsed = value ? new Date(value) : new Date();
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
};

export const buildInterviewRecord = ({ payload, user, sessionId, requestId, details = {} }) => {
    const report = payload?.data?.report;
    if (payload?.header_message !== "interview:end" || payload?.data?.type !== "interview_report" || !report) return null;
    if (!user?._id || !user?.student) throw new Error("A completed student profile is required to save an interview report");

    const meta = report.meta || {};
    const source = meta.source === "job" ? "job" : "profile";
    const inputType = details.input_type === "voice" ? "voice" : details.input_type === "mixed" ? "mixed" : "text";
    return {
        owner: user._id,
        student: user.student._id || user.student,
        requestId: text(requestId, 100),
        sessionId: text(sessionId, 100),
        source,
        candidateName: text(meta.candidate_name || user.name || "Candidate", 200),
        role: text(meta.role || "General", 500),
        durationMinutes: Math.max(0, Number(meta.duration_minutes) || 0),
        questionsAsked: Math.max(0, Math.round(Number(meta.questions_asked) || 0)),
        endedReason: text(meta.ended_reason || payload.data.reason, 200),
        generatedAt: validDate(meta.generated_at),
        inputType,
        targetJob: details.selected_job || null,
        overallScore: score(report.overall_score),
        scores: mapScores(report),
        topics: Array.isArray(report.topics) ? report.topics.slice(0, 20).map((topic) => ({
            topic: text(topic?.topic, 200) || "General",
            score: score(topic?.score),
        })) : [],
        positives: mapFeedbackSide(report.positives),
        negatives: mapFeedbackSide(report.negatives),
        skillGaps: lines(report.skill_gaps),
        summary: text(report.summary, 10000),
        formattedReport: text(payload.response, 50000),
        rawReport: report,
        reportVersion: 1,
    };
};

export const saveCompletedInterview = async (context) => {
    const record = buildInterviewRecord(context);
    if (!record) return null;
    return Interview.findOneAndUpdate(
        { owner: record.owner, requestId: record.requestId },
        { $setOnInsert: record },
        { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
    );
};

export const getLatestInterviewForRecommendations = async (ownerId) => {
    if (!ownerId) return null;
    const interview = await Interview.findOne({ owner: ownerId })
        .sort({ generatedAt: -1, createdAt: -1 })
        .lean();
    if (!interview) return null;
    return {
        interview_id: interview._id.toString(),
        source: interview.source,
        role: interview.role,
        duration_minutes: interview.durationMinutes,
        questions_asked: interview.questionsAsked,
        ended_reason: interview.endedReason,
        generated_at: interview.generatedAt,
        input_type: interview.inputType,
        target_job: interview.targetJob,
        overall_score: interview.overallScore,
        scores: interview.scores,
        topics: interview.topics,
        positives: interview.positives,
        negatives: interview.negatives,
        skill_gaps: interview.skillGaps,
        summary: interview.summary,
        previous_recommendation_plan: interview.recommendationPlan,
    };
};

export const saveInterviewRecommendations = async ({ payload, user }) => {
    if (payload?.header_message !== "learning:recommendations" || payload?.data?.type !== "learning_recommendations") return null;
    const interviewId = text(payload.data.interview_id, 100);
    if (!interviewId || !user?._id) return null;
    return Interview.findOneAndUpdate(
        { _id: interviewId, owner: user._id },
        {
            $set: {
                recommendationPlan: payload.data,
                recommendationsGeneratedAt: new Date(),
            },
        },
        { new: true, runValidators: true },
    );
};

const INTERVIEW_LIST_FIELDS = "source role candidateName durationMinutes questionsAsked endedReason generatedAt inputType targetJob overallScore scores topics positives negatives skillGaps summary recommendationPlan recommendationsGeneratedAt createdAt";

/**
 * The student's interviews, newest first (each with `interviewId`).
 * @param {{includeRaw?: boolean}} [options] includeRaw adds `rawReport` (the UI prefers it for selected_interview)
 */
export const listStudentInterviews = async (ownerId, limit = 20, { includeRaw = false } = {}) => {
    const interviews = await Interview.find({ owner: ownerId })
        .sort({ generatedAt: -1, createdAt: -1 })
        .limit(Math.max(1, Math.min(50, Number(limit) || 20)))
        .select(includeRaw ? `${INTERVIEW_LIST_FIELDS} rawReport` : INTERVIEW_LIST_FIELDS)
        .lean();
    return interviews.map((interview) => ({
        ...interview,
        interviewId: interview._id.toString(),
    }));
}
export const getStudentInterviews = async (userId) => {
    if (!userId) return [];
    return Interview.find({ owner: userId })
        .sort({ createdAt: -1 })
        .limit(30)
        .lean();
};

export const getInterviewById = async (userId, interviewId) => {
    if (!userId || !interviewId) return null;
    return Interview.findOne({ _id: interviewId, owner: userId }).lean();
};
