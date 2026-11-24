import { fetchAllJobSkills } from "../db/job.queries.js";
import { fetchElectivesWithUpvotes } from "../db/elective.queries.js";

/**
 * Build gap-analysis metadata.
 * Contains deduplicated skills from active jobs and elective data with upvote counts.
 * @returns {Promise<{ outputFormat: string, skills: string[], electives: Array<{ name: string, upvoteCount: number, topics: string[] }> }>}
 */
export const buildGapAnalysisMetadata = async () => {
    const [skills, electives] = await Promise.all([
        fetchAllJobSkills(),
        fetchElectivesWithUpvotes(),
    ]);
    return {
        outputFormat: "gap-analysis",
        skills,
        electives,
    };
};
