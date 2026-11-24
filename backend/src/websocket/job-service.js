// Adapter between the websocket layer and the placements module (docs/contracts/PLACEMENTS.md §8).
// Export names are unchanged: metadata-builder.js and ai-query-handler.js call these.
import { listJobsForAgentMetadata, upsertAiCreatedJob } from "../modules/placements/services/drive.service.js";

/**
 * Active drives in the user's scope for the Python agents' metadata, newest first.
 * Capped at 60 drives with descriptions cut to 1500 characters (the agent socket rejects
 * packets over ~1 MB). Students also get `server_eligibility` and `my_application_status`.
 * @returns {Promise<object[]>} snake_case job items ([] without a user)
 */
export const getEligibilityJobs = async (user = null) => (await listJobsForAgentMetadata(user)).jobs;

/** Same as getEligibilityJobs plus `total`, the number of active drives in scope (the list may be capped). */
export const getEligibilityJobsWithTotal = (user = null) => listJobsForAgentMetadata(user);

/**
 * Persist a job confirmed in the AI job-creator chat. One document per draft: a second job in
 * the same chat creates a new drive; re-posting the same draft updates it.
 */
export const persistConfirmedJob = ({ job, user, sessionId, draftId }) => upsertAiCreatedJob({ job, user, sessionId, draftId });
