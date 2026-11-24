import { electiveData } from "../static/electives.js";
import { fetchElectivesWithUpvotes } from "./elective.queries.js";
import { fetchAllJobSkills } from "./job.queries.js";

/**
 * Fetch all data needed for the gap analysis agent:
 * - currentCurriculum: from the static electives.js (the active semester syllabus)
 * - availableElectives: from the Elective MongoDB collection (HOD-selectable options with upvotes)
 * - industrySkills: from the Job collection (deduplicated skills from active job postings)
 *
 * @returns {Promise<{ currentCurriculum: object, availableElectives: Array, industrySkills: string[] }>}
 */
export const fetchGapAnalysisData = async () => {
    const [availableElectives, industrySkills] = await Promise.all([
        fetchElectivesWithUpvotes().catch((err) => {
            console.error("Failed to fetch electives for gap analysis:", err);
            return [];
        }),
        fetchAllJobSkills().catch((err) => {
            console.error("Failed to fetch job skills for gap analysis:", err);
            return [];
        }),
    ]);

    return {
        currentCurriculum: electiveData,
        availableElectives,
        industrySkills,
    };
};
