// Copilot tool of the byok module (AGENT-TOOLS.md §5, RESUME-BYOK.md §12).
// Read-only: it never changes a resume and spends only the student's own key.
import { resolveJobRef } from "../resume-lab/services/job-ref.service.js";
import { resolveResumeRef } from "../resume-lab/services/resume.service.js";
import { assertByokEnabled, hasCredentials, resolveCredentialRef } from "./services/credentials.service.js";
import { tailorResume } from "./services/tailor.service.js";

const NEEDS_KEY = {
    summary: "Resume tailoring uses your own AI key. Add an OpenAI, Anthropic, Google or xAI key in Resume Lab → AI keys, then ask me again.",
    data: { status: "needs_key" },
    ui: { panel: "settings.ai-keys" },
};

const quote = (text) => `“${text}”`;

const resumeTailorForJob = {
    name: "resume_tailor_for_job",
    description: "Suggest surgical, keyword-focused edits to one of the student's resumes for a specific job (campus drive or open-market job), "
        + "using the student's own saved AI key. Nothing is changed: the student reviews and applies the suggestions in the Tailor tab. "
        + "If no job description is available, ask the student to paste it and call again with jobDescription.",
    roles: ["student"],
    confirm: false,
    parameters: {
        type: "object",
        properties: {
            job: { type: "string", description: "id from a job search, 'campus:<id>', 'market:<id>' or 'title at company'" },
            resume: { type: "string", description: "Resume id or title; default = primary resume" },
            credentialId: {
                type: "string",
                description: "Saved key id, provider name (openai/anthropic/google/xai) or key label; default = most recently saved key",
            },
            jobDescription: { type: "string", description: "Only when the student pasted the job description in chat" },
        },
        required: ["job"],
    },
    handler: async (args, ctx) => {
        const user = ctx.user;
        assertByokEnabled();
        if (!await hasCredentials(user._id)) return NEEDS_KEY;

        const resume = await resolveResumeRef(user, args.resume);
        if (resume?.ambiguous) return resume;
        const job = await resolveJobRef(args.job, { user });
        if (job?.ambiguous) return job;
        const credential = await resolveCredentialRef(user._id, args.credentialId);
        if (credential?.ambiguous) return credential;

        let result;
        try {
            result = await tailorResume(user, {
                resumeId: String(resume._id),
                jobId: job.id,
                jobSource: job.source,
                manualJobDescription: typeof args.jobDescription === "string" && args.jobDescription.trim() ? args.jobDescription : undefined,
                saveJobDescription: true,
                credentialId: credential.credentialId,
                provider: credential.provider,
            });
        } catch (error) {
            if (error?.errors?.[0]?.code === "LLM_KEY_REQUIRED") return NEEDS_KEY;
            throw error;
        }

        const resumeId = String(resume._id);
        if (result.requiresManualJD) {
            return {
                summary: `I couldn't find a description for ${quote(job.title || "this job")}. Paste the job description here (or in the Tailor tab) and I'll continue.`,
                data: { status: "needs_job_description", jobId: job.id, jobSource: job.source },
                ui: {
                    panel: "resume.lab",
                    params: { tab: "tailor", resumeId, jobId: job.id, jobSource: job.source },
                    data: { resumeId, jobId: job.id, jobSource: job.source, requiresManualJD: true, message: result.message },
                },
            };
        }

        const keywords = [...new Set(result.patches.flatMap((patch) => patch.keywordsAdded))].slice(0, 5);
        const target = `${job.title || "this job"}${job.company ? ` at ${job.company}` : ""}`;
        let summary = result.totalPatches === 0
            ? "Your resume already covers this job's key requirements — I found no safe edits."
            : `Prepared ${result.totalPatches} suggested edit(s) for ${quote(resume.title)} targeting ${target}`
                + `${keywords.length ? ` — adds ${keywords.join(", ")}` : ""}. Nothing has been changed yet; review and apply them in the Tailor tab.`;
        if (result.appliesTo === "extracted_text") {
            summary += ` (suggestions only — your resume is a ${(resume.kind || "pdf").toUpperCase()})`;
        }
        return {
            summary,
            data: {
                status: "ok",
                resumeId,
                jobId: job.id,
                jobSource: job.source,
                totalPatches: result.totalPatches,
                missingKeywordsFound: result.missingKeywordsFound,
                patches: result.patches.map((patch) => ({
                    id: patch.id,
                    section: patch.section,
                    targetContext: patch.targetContext,
                    keywordsAdded: patch.keywordsAdded,
                    reasoning: patch.reasoning,
                    lineRange: patch.lineRange,
                })),
            },
            ui: {
                panel: "resume.lab",
                params: { tab: "tailor", resumeId, jobId: job.id, jobSource: job.source, credentialId: result.credentialId },
                data: {
                    resumeId,
                    jobId: job.id,
                    jobSource: job.source,
                    credentialId: result.credentialId,
                    provider: result.provider,
                    model: result.model,
                    patches: result.patches,
                    missingKeywordsFound: result.missingKeywordsFound,
                    totalPatches: result.totalPatches,
                    requiresManualJD: false,
                    sourceHash: result.sourceHash,
                    revision: result.revision,
                    appliesTo: result.appliesTo,
                    skipped: result.skipped,
                },
            },
        };
    },
};

export default [resumeTailorForJob];
