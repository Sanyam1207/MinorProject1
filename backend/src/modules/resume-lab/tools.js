// Copilot tools of the resume-lab module (AGENT-TOOLS.md §5, RESUME-BYOK.md §12).
// Read-only: they never change a resume.
import { resolveJobRef } from "./services/job-ref.service.js";
import { getPrimaryResume, listResumes, resolveResumeRef, scoreResumeDoc } from "./services/resume.service.js";

const catalogUi = { panel: "resume.lab", params: { tab: "catalog" } };
const quote = (text) => `“${text}”`;

const resumeList = {
    name: "resume_list",
    description: "List the student's resumes in Resume Lab (title, kind latex/pdf/docx/text, version, ATS score, which one is primary). "
        + "Use before scoring or tailoring when the student refers to a resume by name.",
    roles: ["student"],
    confirm: false,
    parameters: {
        type: "object",
        properties: {
            includeArchived: { type: "boolean", description: "Also list archived (shared or submitted) versions. Default false." },
        },
    },
    handler: async (args, ctx) => {
        const { resumes, primaryId } = await listResumes(ctx.user._id, { status: args.includeArchived ? "all" : "active" });
        const data = {
            resumes: resumes.map((resume) => ({
                id: resume.id,
                title: resume.title,
                kind: resume.kind,
                version: resume.version,
                isPrimary: resume.isPrimary,
                atsScore: resume.atsScore,
                updatedAt: resume.updatedAt,
                ...(resume.status !== "active" ? { status: resume.status } : {}),
            })),
            primaryId,
        };
        if (!resumes.length) {
            return { summary: "You have no resumes yet. Upload one in Resume Lab or ask me to generate one.", data, ui: catalogUi };
        }
        const listed = resumes.slice(0, 10).map((resume) => {
            const ats = resume.atsScore === null || resume.atsScore === undefined ? "" : `, ATS ${resume.atsScore}`;
            return `${quote(resume.title)} (${resume.kind.toUpperCase()}, v${resume.version}${ats})${resume.isPrimary ? " ★ primary" : ""}`;
        });
        const more = resumes.length > 10 ? ` … and ${resumes.length - 10} more` : "";
        return {
            summary: `You have ${resumes.length} resume(s): ${listed.join("; ")}${more}`,
            data,
            ui: catalogUi,
        };
    },
};

const resumeScore = {
    name: "resume_score",
    description: "Score one of the student's resumes with the deterministic ATS checker (0–100 with a breakdown and the top fixes), "
        + "optionally against a campus drive or open-market job. Defaults to the primary resume.",
    roles: ["student"],
    confirm: false,
    parameters: {
        type: "object",
        properties: {
            resume: { type: "string", description: "Resume id or title; default = primary resume" },
            job: {
                type: "string",
                description: "Optional job to score against: id from a job search, 'campus:<id>', 'market:<id>' or 'title at company'",
            },
        },
    },
    handler: async (args, ctx) => {
        const user = ctx.user;
        if (!args.resume && !await getPrimaryResume(user._id)) {
            return {
                summary: "You don't have a resume yet. Upload one in Resume Lab and I'll score it.",
                data: { resume: null },
                ui: catalogUi,
            };
        }
        const resume = await resolveResumeRef(user, args.resume, { select: "+extractedText" });
        if (resume?.ambiguous) return resume;
        let job = null;
        if (typeof args.job === "string" && args.job.trim()) {
            job = await resolveJobRef(args.job, { user });
            if (job?.ambiguous) return job;
        }
        const result = await scoreResumeDoc(user, resume, job);
        const fixes = (result.feedback?.improvements || []).slice(0, 3);
        const against = job ? ` against ${job.title || "this job"}${job.company ? ` at ${job.company}` : ""}` : "";
        const fixText = fixes.length
            ? ` Top fixes: ${fixes.map((fix, index) => `${index + 1}) ${fix}`).join(" ")}`
            : " No major fixes needed.";
        const params = { tab: "ats", resumeId: String(resume._id) };
        if (job) Object.assign(params, { jobId: job.id, jobSource: job.source });
        return {
            summary: `${quote(resume.title)} scores ${result.score}/100 (${result.grade})${against}.${fixText}`,
            data: {
                resumeId: String(resume._id),
                score: result.score,
                grade: result.grade,
                rubricBreakdown: result.feedback.rubricBreakdown,
                improvements: result.feedback.improvements,
                missingKeywords: result.keywords?.missing || [],
                target: result.target,
            },
            ui: { panel: "resume.lab", params, data: result },
        };
    },
};

export default [resumeList, resumeScore];
