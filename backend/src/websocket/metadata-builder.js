import { buildProfile, getInstitutionContext } from "./auth-context.js";
import { getEligibilityJobsWithTotal } from "./job-service.js";
import { buildUserContextMetadata } from "../utils/user-context-metadata.js";
import { getAvailableAlumniForStudent } from "../services/alumni.service.js";
import { getLatestResumeForAnalysis, listResumeMetadata } from "../services/resume-bank.service.js";
import { getStudentInterviews } from "../services/interview.service.js";
import { AlumniConnection } from "../models/alumni.models.js";
import { fetchGapAnalysisData } from "../db/gap-analysis.queries.js";
import { getLatestInterviewForRecommendations } from "../services/interview.service.js";
import { getReadableResourcesForInterview } from "../services/learning-resource.service.js";

const ELIGIBILITY_CONTRACT = {
    output_format: "job-eligibility",
    valid_actions: ["check_eligibility", "job_details", "audit", "clarify"],
    rules: [
        "Use profile and jobs from metadata before asking the user for information.",
        "CGPA must be a number between 0 and 10.",
        "Keep the selected job and collected profile values for the current session.",
        "Never invent a missing eligibility value.",
        "When a job has server_eligibility, report that verdict and its reasons; never re-evaluate it.",
    ],
};

export const buildRequestMetadata = async ({ modeName, user, effectiveRole, details }) => {
    const normalizedMode = String(modeName || "").trim().toLowerCase().replaceAll("_", "-");
    if (normalizedMode === "copilot") {
        // The copilot fetches everything else through agent tools on demand.
        const profile = buildProfile(user, details);
        const institution = await getInstitutionContext(user, effectiveRole);
        return { profile, ...institution };
    }
    if (normalizedMode === "learning-recommendation") {
        const profile = buildProfile(user, details);
        const institution = await getInstitutionContext(user, effectiveRole);
        const latestInterview = effectiveRole === "student" && user
            ? await getLatestInterviewForRecommendations(user._id)
            : null;
        return {
            profile,
            ...institution,
            latest_interview: latestInterview,
            readable_resources: getReadableResourcesForInterview(latestInterview || {}),
            recommendation_contract: {
                content_formats: ["documentation", "article", "written-guide", "study-notes", "cheat-sheet", "case-study"],
                excluded_formats: ["video", "audio", "podcast"],
                max_priorities: 3,
                rules: [
                    "Base every recommendation on the stored interview report.",
                    "Recommend readable material only.",
                    "Select only resource_id values from readable_resources; the server owns titles and URLs.",
                ],
            },
        };
    }
    const buildAlumniJourneyContext = async () => {
        if (effectiveRole !== "student" || !user) return {};
        const [candidateAlumni, resumeBank, acceptedConnections] = await Promise.all([
            getAvailableAlumniForStudent(user),
            listResumeMetadata(user._id),
            AlumniConnection.find({ student: user._id, status: "accepted" })
                .populate("alumni", "name company currentRole")
                .select("alumni requestType status")
                .lean(),
        ]);
        return {
            selected_job: details.selected_job || null,
            resume: typeof details.resume === "string" ? details.resume.slice(0, 100000) : "",
            candidate_alumni: candidateAlumni,
            resume_bank: resumeBank,
            accepted_alumni_connections: acceptedConnections,
        };
    };

    if (normalizedMode === "gap-analysis") {
        const profile = buildProfile(user, details);
        const institution = await getInstitutionContext(user, effectiveRole);
        let gapData = { currentCurriculum: [], availableElectives: [], industrySkills: [] };
        try {
            gapData = await fetchGapAnalysisData();
        } catch (error) {
            console.error("Unable to load gap analysis data:", error);
        }
        return {
            profile,
            ...institution,
            current_curriculum: gapData.currentCurriculum,
            available_electives: gapData.availableElectives,
            industry_skills: gapData.industrySkills,
        };
    }

    if (normalizedMode === "pr-outreach") {
        const userContext = await buildUserContextMetadata({ user, effectiveRole });
        return { ...userContext, ...(await buildAlumniJourneyContext()) };
    }

    if (normalizedMode === "alumni-connect") {
        const profile = buildProfile(user, details);
        const institution = await getInstitutionContext(user, effectiveRole);
        return {
            profile,
            ...institution,
            alumni_id: details.alumni_id || "",
            request_type: details.request_type || "career-guidance",
            share_resume: Boolean(details.share_resume),
            ...(await buildAlumniJourneyContext()),
        };
    }

    const profile = buildProfile(user, details);
    const institution = await getInstitutionContext(user, effectiveRole);

    if (normalizedMode === "ai-interviewer") {
        let jobs = [];
        let jobsTotal = 0;
        try {
            ({ jobs, total: jobsTotal } = await getEligibilityJobsWithTotal(user));
        } catch (error) {
            console.error("Unable to load jobs for interviewer metadata:", error);
        }
        return {
            profile,
            ...institution,
            jobs,
            jobs_total: jobsTotal,
            selected_job: details.selected_job || null,
            interview_input: {
                type: details.input_type === "voice" ? "voice" : "text",
                duration_seconds: Number.isFinite(Number(details.speech_duration_seconds))
                    ? Math.max(0, Math.min(300, Number(details.speech_duration_seconds)))
                    : 0,
                language: typeof details.speech_language === "string"
                    ? details.speech_language.slice(0, 20)
                    : "",
            },
            ...(await buildAlumniJourneyContext()),
        };
    }

    if (normalizedMode === "resume-generator") {
        const journey = await buildAlumniJourneyContext();
        const latestResume = effectiveRole === "student" && user && !journey.resume
            ? await getLatestResumeForAnalysis(user._id)
            : null;
        return {
            profile,
            ...institution,
            ...journey,
            latest_resume: latestResume,
        };
    }

    if (normalizedMode === "learning-recommendation" || normalizedMode === "learning-recommendations" || normalizedMode === "recommendation") {
        let pastInterviews = [];
        if (user?._id) {
            try {
                pastInterviews = await getStudentInterviews(user._id);
            } catch (error) {
                console.error("Unable to load student interviews for recommendations:", error);
            }
        }
        return {
            profile,
            ...institution,
            past_interviews: pastInterviews,
            selected_interview: details.selected_interview || null,
            latest_interview: details.latest_interview || (details.selected_interview ? null : (pastInterviews.length > 0 ? (pastInterviews[0].rawReport || pastInterviews[0]) : null)),
            ...(await buildAlumniJourneyContext()),
        };
    }

    // A new chat has no mode until Python routes its first prompt. Include
    // eligibility context on that unrouted turn so the selected agent does
    // not receive an empty jobs list and ask the user to identify a job that
    // Node already has in MongoDB.
    const needsEligibilityContext = !normalizedMode
        || normalizedMode === "job-eligibility"
        || normalizedMode === "job-eligiblity";

    if (!needsEligibilityContext) {
        return { profile, ...institution, ...(await buildAlumniJourneyContext()) };
    }

    let jobs = [];
    let jobsTotal = 0;
    try {
        ({ jobs, total: jobsTotal } = await getEligibilityJobsWithTotal(user));
    } catch (error) {
        console.error("Unable to load jobs for eligibility metadata:", error);
    }

    return {
        ...ELIGIBILITY_CONTRACT,
        profile,
        jobs,
        // `jobs` holds at most the 60 most recent active drives; this is how many exist in scope.
        jobs_total: jobsTotal,
        ...institution,
        ...(await buildAlumniJourneyContext()),
    };
};
