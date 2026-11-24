import { Router } from "express";
import mongoose from "mongoose";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import asynchandler from "../utils/asynchandler.js";
import { ApiError } from "../utils/api-error.js";
import { Apiresponse } from "../utils/api-response.js";
import { College } from "../models/college.models.js";
import { User } from "../models/user.models.js";
import {
    ALUMNI_REQUEST_TYPES,
    AlumniConnection,
    AlumniProfile,
    MentorshipMessage,
} from "../models/alumni.models.js";
import { getAvailableAlumniForStudent, getStudentCollegeId } from "../services/alumni.service.js";
import { Resume } from "../models/resume.models.js";
import { lockResume, resumeSnapshot } from "../modules/resume-lab/services/resume.service.js";
import {
    claimAlumniRequestReview,
    completeAlumniRequestReview,
    releaseAlumniRequestReview,
} from "../utils/alumni-review-session.js";
import {
    claimResumeShareReview,
    completeResumeShareReview,
    releaseResumeShareReview,
} from "../utils/resume-share-review-session.js";

const router = Router();
router.use(verifyJWT);

const requireRole = (req, role) => {
    if (req.user.role !== role) throw new ApiError(403, `${role} account required`);
};
const objectId = (value, label = "identifier") => {
    if (!mongoose.isValidObjectId(value)) throw new ApiError(400, `Invalid ${label}`);
    return value;
};
const cleanList = (value) => Array.isArray(value)
    ? value.map((item) => String(item).trim().slice(0, 100)).filter(Boolean).slice(0, 30)
    : [];

const findMemberConnection = async (req) => {
    const connection = await AlumniConnection.findOne({
        _id: objectId(req.params.id, "connection ID"),
        $or: [{ student: req.user._id }, { alumniUser: req.user._id }],
    });
    if (!connection) throw new ApiError(404, "Connection not found");
    return connection;
};

router.get("/colleges", asynchandler(async (req, res) => {
    requireRole(req, "alumni");
    const colleges = await College.find().select("name domain branches").sort({ name: 1 }).lean();
    return res.json(new Apiresponse(200, colleges, "Colleges loaded"));
}));

router.get("/profile", asynchandler(async (req, res) => {
    requireRole(req, "alumni");
    const profile = await AlumniProfile.findOne({ user: req.user._id }).lean();
    return res.json(new Apiresponse(200, profile, "Alumni profile loaded"));
}));

router.put("/profile", asynchandler(async (req, res) => {
    requireRole(req, "alumni");
    const body = req.body || {};
    const collegeId = objectId(body.college, "college ID");
    if (!await College.exists({ _id: collegeId })) throw new ApiError(400, "Choose a valid college");

    const graduationYear = Number(body.graduationYear);
    const capacity = Number(body.capacity);
    const requestTypes = cleanList(body.requestTypes);
    if (!Number.isInteger(graduationYear) || graduationYear < 1950 || graduationYear > new Date().getFullYear()) {
        throw new ApiError(400, "Enter a valid graduation year");
    }
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 20) {
        throw new ApiError(400, "Mentoring capacity must be between 1 and 20");
    }
    if (!requestTypes.length || requestTypes.some((type) => !ALUMNI_REQUEST_TYPES.includes(type))) {
        throw new ApiError(400, "Choose at least one valid mentoring request type");
    }

    const fields = {
        college: collegeId,
        name: String(body.name || "").trim().slice(0, 150),
        branch: String(body.branch || "").trim().slice(0, 150),
        degree: String(body.degree || "").trim().slice(0, 150),
        graduationYear,
        company: String(body.company || "").trim().slice(0, 200),
        currentRole: String(body.currentRole || "").trim().slice(0, 200),
        location: String(body.location || "").trim().slice(0, 200),
        bio: String(body.bio || "").trim().slice(0, 2000),
        skills: cleanList(body.skills),
        mentoringTopics: cleanList(body.mentoringTopics),
        languages: cleanList(body.languages),
        requestTypes,
        availability: String(body.availability || "").trim().slice(0, 500),
        capacity,
        acceptingRequests: body.acceptingRequests !== false,
        onboardingComplete: true,
    };
    if (!fields.name || !fields.branch || !fields.company || !fields.currentRole) {
        throw new ApiError(400, "Complete your name, branch, company, and current role");
    }

    const profile = await AlumniProfile.findOneAndUpdate(
        { user: req.user._id },
        { $set: fields, $setOnInsert: { user: req.user._id, verificationStatus: "unverified" } },
        { upsert: true, new: true, runValidators: true },
    );
    await User.findByIdAndUpdate(req.user._id, { $set: { name: fields.name, college: collegeId } });
    return res.json(new Apiresponse(200, profile, "Alumni onboarding saved"));
}));

router.get("/discover", asynchandler(async (req, res) => {
    requireRole(req, "student");
    return res.json(new Apiresponse(200, await getAvailableAlumniForStudent(req.user), "Available alumni loaded"));
}));

router.get("/connections", asynchandler(async (req, res) => {
    if (!["student", "alumni"].includes(req.user.role)) throw new ApiError(403, "Student or alumni account required");
    const connections = await AlumniConnection.find({
        $or: [{ student: req.user._id }, { alumniUser: req.user._id }],
    })
        .populate("student", "name branch collegeName passingYear skills")
        .populate("alumni", "name company currentRole branch graduationYear availability isDemo")
        .sort({ updatedAt: -1 })
        .lean();
    return res.json(new Apiresponse(200, connections, "Connections loaded"));
}));

router.post("/connections", asynchandler(async (req, res) => {
    requireRole(req, "student");
    const body = req.body || {};
    const sessionId = String(body.sessionId || "").trim();
    const message = String(body.message || "").trim();
    if (!sessionId) throw new ApiError(400, "Alumni agent session ID is required");
    if (!message || message.length > 3000) throw new ApiError(400, "Connection message must contain 1–3000 characters");

    const review = claimAlumniRequestReview({ sessionId, userId: req.user._id, request: body });
    if (!review.ok) {
        if (review.reason === "forbidden") throw new ApiError(403, "This reviewed request belongs to another user");
        if (review.reason === "changed") throw new ApiError(409, "The request changed after review. Ask the alumni agent to review it again");
        if (review.reason === "expired") throw new ApiError(409, "The reviewed request expired. Ask the alumni agent to review it again");
        throw new ApiError(409, "Ask the alumni agent to prepare and review this request before sending");
    }

    try {
        const studentCollegeId = await getStudentCollegeId(req.user);
        if (!studentCollegeId) throw new ApiError(409, "Complete your student college profile before connecting with alumni");
        const alumni = await AlumniProfile.findOne({
            _id: objectId(body.alumniId, "alumni ID"),
            college: studentCollegeId,
            acceptingRequests: true,
            onboardingComplete: true,
        });
        if (!alumni || !alumni.requestTypes.includes(body.requestType)) {
            throw new ApiError(409, "This alumnus is no longer available for that request type");
        }
        if (await AlumniConnection.exists({ student: req.user._id, alumni: alumni._id })) {
            throw new ApiError(409, "You already have a request or connection with this alumnus");
        }
        if (await AlumniConnection.countDocuments({ student: req.user._id, status: { $in: ["pending", "accepted"] } }) >= 3) {
            throw new ApiError(409, "You already have three open alumni connections");
        }
        if (await AlumniConnection.countDocuments({ alumni: alumni._id, status: { $in: ["pending", "accepted"] } }) >= alumni.capacity) {
            throw new ApiError(409, "This alumnus has reached their mentoring capacity");
        }

        const connection = await AlumniConnection.create({
            student: req.user._id,
            alumni: alumni._id,
            alumniUser: alumni.user,
            requestType: body.requestType,
            message,
            selectedJob: body.selectedJob || null,
            sharedResume: body.shareResume ? String(body.resume || "").slice(0, 100000) : "",
        });
        completeAlumniRequestReview(sessionId);
        return res.status(201).json(new Apiresponse(201, connection, "Connection request sent"));
    } catch (error) {
        releaseAlumniRequestReview(sessionId);
        throw error;
    }
}));

router.patch("/connections/:id", asynchandler(async (req, res) => {
    const connection = await findMemberConnection(req);
    const target = String(req.body?.status || "");
    const isAlumni = String(connection.alumniUser) === String(req.user._id);
    const valid = (isAlumni && connection.status === "pending" && ["accepted", "declined"].includes(target))
        || (["pending", "accepted"].includes(connection.status) && target === "closed");
    if (!valid) throw new ApiError(409, "That connection status change is not allowed");

    const updated = await AlumniConnection.findOneAndUpdate(
        { _id: connection._id, status: connection.status },
        { $set: { status: target } },
        { new: true },
    );
    if (!updated) throw new ApiError(409, "Connection changed; refresh and try again");
    return res.json(new Apiresponse(200, updated, "Connection updated"));
}));

router.get("/connections/:id/messages", asynchandler(async (req, res) => {
    const connection = await findMemberConnection(req);
    if (!["accepted", "closed"].includes(connection.status)) throw new ApiError(403, "Conversation opens after acceptance");
    const messages = await MentorshipMessage.find({ connection: connection._id })
        .sort({ createdAt: -1 })
        .limit(200)
        .populate("sender", "name")
        .populate("resumeVersion", "title version targetJob status kind")
        .lean();
    return res.json(new Apiresponse(200, messages.reverse(), "Messages loaded"));
}));

router.post("/connections/:id/share-resume", asynchandler(async (req, res) => {
    requireRole(req, "student");
    const sessionId = String(req.body?.sessionId || "").trim();
    const resumeVersionId = objectId(req.body?.resumeVersionId, "resume version ID");
    const messageText = String(req.body?.message || "Here is the resume you requested.").trim().slice(0, 3000);
    if (!sessionId) throw new ApiError(400, "Alumni agent session ID is required");

    const review = claimResumeShareReview({
        sessionId,
        userId: req.user._id,
        request: { connectionId: req.params.id, resumeVersionId, message: messageText },
    });
    if (!review.ok) {
        if (review.reason === "changed") throw new ApiError(409, "The resume share changed after review. Ask the alumni agent to review it again");
        if (review.reason === "forbidden") throw new ApiError(403, "This reviewed share belongs to another user");
        throw new ApiError(409, "Ask the alumni agent to review this resume share before confirming");
    }

    try {
        const connection = await AlumniConnection.findOne({
            _id: objectId(req.params.id, "connection ID"),
            student: req.user._id,
            status: "accepted",
        });
        if (!connection) throw new ApiError(409, "Resume sharing requires an accepted alumni connection");
        const resume = await Resume.findOne({ _id: resumeVersionId, owner: req.user._id, status: "active" });
        if (!resume) throw new ApiError(404, "Active resume version not found in your Resume Bank");

        const message = await MentorshipMessage.create({
            connection: connection._id,
            sender: req.user._id,
            text: messageText || "Here is the resume you requested.",
            type: "resume-share",
            resumeVersion: resume._id,
            resumeSnapshot: resumeSnapshot(resume),
        });
        // The shared version must never change afterwards (RESUME-BYOK §13);
        // edits go through "duplicate". A lock failure never fails the share.
        try {
            await lockResume(resume._id, "alumni-share");
        } catch (lockError) {
            console.error(`[alumni] could not lock shared resume ${resume._id}:`, lockError);
        }
        completeResumeShareReview(sessionId);
        return res.status(201).json(new Apiresponse(201, message, "Resume shared with alumnus"));
    } catch (error) {
        releaseResumeShareReview(sessionId);
        throw error;
    }
}));

router.post("/connections/:id/messages", asynchandler(async (req, res) => {
    const connection = await findMemberConnection(req);
    if (connection.status !== "accepted") throw new ApiError(403, "Connection must be accepted before messaging");
    const text = String(req.body?.text || "").trim();
    if (!text || text.length > 3000) throw new ApiError(400, "Message must contain 1–3000 characters");
    const message = await MentorshipMessage.create({ connection: connection._id, sender: req.user._id, text });
    return res.status(201).json(new Apiresponse(201, message, "Message sent"));
}));

export default router;
