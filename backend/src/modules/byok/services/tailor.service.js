// Surgical resume tailoring (RESUME-BYOK.md §9.5), port of Matchy `callLlm`.
//
// Fixes over Matchy: per-user job descriptions (never written to shared job
// documents), campus + market jobs, loose JSON parsing, patch validation that
// drops hallucinated substrings / unbalanced LaTeX / overlaps, and the key is
// paid only by the student's own credential. Tailoring never modifies a resume.
import crypto from "node:crypto";
import { fail } from "../../../core/http.js";
import { maxSourceBytes } from "../../resume-lab/config.js";
import {
    cleanManualJd,
    jobContextBlock,
    normalizeJobSource,
    publicJob,
    resolveJob,
    resolveJobDescription,
} from "../../resume-lab/services/job-ref.service.js";
import { addLineNumbers, validateAndLocatePatches } from "../../resume-lab/services/patches.js";
import { getResumeForOwner } from "../../resume-lab/services/resume.service.js";
import { CHAT_MAX_CHARS, CHAT_MAX_MESSAGES } from "../config.js";
import { notifyKeyInvalid, pickCredential } from "./credentials.service.js";
import { GenericLlmClient } from "./llm-client.js";

// Verbatim from Matchy `llm.controller.js` (current 8-rule version).
export const RESUME_DIFF_SYSTEM_PROMPT = `You are a surgical Resume Keyword & ATS Optimization Engine for .tex (LaTeX) and .txt resumes.
Your ONLY job is to suggest targeted, minimal replacements that naturally weave missing keywords and skills from the Job Description into the user's existing resume bullets, project descriptions, or skills section.

STRICT RULES:
1. DO NOT regenerate the entire resume. Return ONLY the specific changes (diffs).
2. DO NOT alter the structure, document layout, preamble, section headers, or spacing of the resume.
3. For .tex files, PRESERVE all LaTeX commands and macros (e.g., \\resumeItem{...}, \\textbf{...}, \\item, \\emph{...}) and ensure every opening brace "{" has a matching closing brace "}". Escape special LaTeX characters (\\%, \\&, \\$, \\#, \\_) if you introduce them inside text.
4. "originalSubstring" MUST be copied character-for-character from the user's resume (WITHOUT the [Lxx] line prefix tag) so the backend can run an exact substring match.
5. Make bullets more compelling and ownership-oriented when the resume supports it: prefer precise action verbs such as "built", "owned", "designed", "implemented", or "led" over vague wording such as "helped" or "collaborated". Do not imply leadership or sole ownership when the original evidence does not support it.
6. Replace generic claims with concrete impact and measurable outcomes whenever the resume already contains evidence for them (counts, percentages, latency, revenue, users, scale, or time). Never invent numbers, metrics, employers, projects, responsibilities, or achievements. If a useful metric is missing, improve the wording without fabricating one.
7. Keep edits grounded in the user's existing projects and experience—inject relevant keywords from the Job Description where contextually appropriate or sharpen phrasing instead of inventing fake work history.
8. Respond ONLY with valid JSON matching this exact schema:
{
  "missingKeywordsFound": ["string"],
  "suggestions": [
    {
      "id": "patch_1",
      "lineNumber": 42,
      "section": "Projects | Experience | Skills",
      "targetContext": "Name of the project or role being modified",
      "originalSubstring": "Exact verbatim line or sentence from the resume without [Lxx] tag",
      "replacementSubstring": "The updated line or sentence with the keyword injected, keeping all LaTeX tags intact",
      "keywordsAdded": ["Redux"],
      "reasoning": "Brief 1-sentence explanation of why this keyword or sentence replacement fits here"
    }
  ]
}`;

export const MANUAL_JOB_DESCRIPTION_MESSAGE =
    "Hey, please paste the job description—I'm not able to get it automatically. Just copy and paste the job description over here.";

const badJson = () => fail(502, "The AI returned an unreadable answer. Try again or pick another model.", "LLM_BAD_JSON");

/** Strict JSON → fenced JSON → first `{` … last `}` slice → 502 LLM_BAD_JSON. */
export const parseJsonLoose = (content) => {
    const text = String(content ?? "").trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim();
    try {
        return JSON.parse(text);
    } catch {
        const start = text.indexOf("{");
        const end = text.lastIndexOf("}");
        if (start !== -1 && end > start) {
            try {
                return JSON.parse(text.slice(start, end + 1));
            } catch {
                // fall through
            }
        }
        throw badJson();
    }
};

const present = (value) => value !== undefined && value !== null && value !== "";

const callProvider = async (user, picked, messages, options) => {
    const client = new GenericLlmClient(picked.provider, picked.apiKey, picked.model);
    try {
        return await client.complete(messages, options);
    } catch (error) {
        if (error?.errors?.[0]?.code === "LLM_KEY_INVALID") await notifyKeyInvalid(user._id, picked.credential);
        throw error;
    }
};

/**
 * POST /llm/tailor.
 * @returns {Promise<TailorResult | NeedsJd>}
 */
export const tailorResume = async (user, body = {}) => {
    // 1. validate
    const hasResumeId = present(body.resumeId);
    const hasContent = typeof body.resumeContent === "string" && body.resumeContent.trim() !== "";
    if (hasResumeId === hasContent) {
        throw fail(400, "Send exactly one of resumeId or resumeContent", "VALIDATION", { field: "resumeId" });
    }
    const jobObject = body.job && typeof body.job === "object" ? body.job : null;
    const jobId = present(body.jobId) ? String(body.jobId) : present(jobObject?.id) ? String(jobObject.id)
        : present(body.applyingId) ? String(body.applyingId) : null;
    const jobSource = normalizeJobSource(body.jobSource ?? body.jobKind ?? jobObject?.source ?? jobObject?.kind);
    const manualText = cleanManualJd(body.manualJobDescription);
    if (!jobId && !manualText) throw fail(400, "Pick a job or paste a job description", "VALIDATION", { field: "jobId" });

    // 2. resume
    let resume = null;
    let source;
    let fileType;
    let appliesTo = "source";
    if (hasResumeId) {
        resume = await getResumeForOwner(user._id, body.resumeId, { select: "+source +extractedText" });
        const kind = resume.kind || "latex";
        if (kind === "latex" || kind === "text") {
            source = resume.source || "";
            fileType = kind === "latex" ? "tex" : "txt";
        } else {
            source = resume.extractedText || "";
            fileType = "txt";
            appliesTo = "extracted_text";
            if (!source.trim()) {
                throw fail(422, "No text could be read from this resume, so it can't be tailored. Upload a text-based PDF or DOCX.", "UNREADABLE_FILE");
            }
        }
    } else {
        source = body.resumeContent.replace(/\r\n?/g, "\n");
        const requested = present(body.fileType) ? String(body.fileType).toLowerCase() : null;
        if (requested && !["tex", "txt"].includes(requested)) throw fail(400, "fileType must be tex or txt", "VALIDATION", { field: "fileType" });
        fileType = requested || (source.includes("\\documentclass") ? "tex" : "txt");
    }
    if (Buffer.byteLength(source, "utf8") > maxSourceBytes()) {
        throw fail(413, "The resume is too large to tailor", "SOURCE_TOO_LARGE");
    }

    // 3. job
    const job = jobId ? await resolveJob({ jobSource, jobId }, { user }) : null;

    // 4. credential (checked before the job description, as in Matchy)
    const picked = await pickCredential(user._id, { credentialId: body.credentialId, provider: body.provider, model: body.model });

    // 5. job description
    const jd = await resolveJobDescription({ user, job, manualText, save: body.saveJobDescription !== false });
    if (!jd.text) {
        return {
            success: false,
            requiresManualJD: true,
            message: MANUAL_JOB_DESCRIPTION_MESSAGE,
            job: publicJob(job),
            jobId: job?.id ?? null,
            jobSource: job?.source ?? null,
            resumeId: resume ? String(resume._id) : null,
        };
    }

    // 6. prompt
    const userPrompt = `JOB DESCRIPTION:
"""
${jobContextBlock(job, jd.text)}
"""

USER RESUME (${fileType.toUpperCase()} FORMAT WITH LINE TAGS):
"""
${addLineNumbers(source)}
"""

Identify missing keywords from the Job Description and return surgical JSON diff suggestions without changing the resume structure.`;
    const completion = await callProvider(user, picked, [
        { role: "system", content: RESUME_DIFF_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
    ], { jsonMode: true });

    // 7. parse
    const parsed = parseJsonLoose(completion.content);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.suggestions)) throw badJson();

    // 8. validate + locate
    const isLatex = fileType === "tex" || (appliesTo === "source" && source.includes("\\documentclass"));
    const { patches, skipped } = validateAndLocatePatches(source, parsed.suggestions, isLatex);
    const missingKeywordsFound = (Array.isArray(parsed.missingKeywordsFound) ? parsed.missingKeywordsFound : [])
        .filter((item) => typeof item === "string" && item.trim())
        .map((item) => item.trim().slice(0, 60))
        .slice(0, 30);

    return {
        success: true,
        requiresManualJD: false,
        resumeId: resume ? String(resume._id) : null,
        sourceHash: resume ? resume.sourceHash : crypto.createHash("sha256").update(source).digest("hex"),
        revision: resume ? resume.revision || 1 : null,
        fileType,
        appliesTo,
        job: publicJob(job),
        jobId: job?.id ?? null,
        jobSource: job?.source ?? null,
        jobDescriptionSource: jd.source,
        provider: picked.provider,
        model: completion.model,
        credentialId: String(picked.credential._id),
        missingKeywordsFound,
        totalPatches: patches.length,
        patches,
        skipped,
        generatedAt: new Date().toISOString(),
    };
};

/** POST /llm/chat (non-tailoring): plain completion with the user's key. */
export const chatCompletion = async (user, body = {}) => {
    const messages = body.messages;
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > CHAT_MAX_MESSAGES) {
        throw fail(400, `messages must be an array of 1–${CHAT_MAX_MESSAGES} messages`, "VALIDATION", { field: "messages" });
    }
    const total = messages.reduce((sum, message) => sum + (typeof message?.content === "string" ? message.content.length : 0), 0);
    if (total > CHAT_MAX_CHARS) throw fail(413, "The conversation is too long", "SOURCE_TOO_LARGE");
    const picked = await pickCredential(user._id, { credentialId: body.credentialId, provider: body.provider, model: body.model });
    const result = await callProvider(user, picked, messages, {});
    return { provider: result.provider, model: result.model, content: result.content, stopReason: result.stopReason, usage: result.usage };
};
