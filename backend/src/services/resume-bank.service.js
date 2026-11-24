// SIH Resume Bank compatibility exports (docs/contracts/RESUME-BYOK.md §13).
// Implemented by the resume-lab module; kept here so existing callers
// (websocket/metadata-builder.js, placements) keep importing this path.
// buildPrivateResumeUrl(resume, {viewerId}) stays synchronous and returns a string.
export {
    buildPrivateResumeUrl,
    getLatestResumeForAnalysis,
    listResumeMetadata,
    saveGeneratedResume,
} from "../modules/resume-lab/services/resume.service.js";
