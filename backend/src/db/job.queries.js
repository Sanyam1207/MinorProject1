import { Job } from "../models/job.models.js";

/**
 * Fetch all unique skills from active jobs.
 * @returns {Promise<string[]>} Deduplicated, sorted array of skill strings.
 */
export const fetchAllJobSkills = async () => {
    const jobs = await Job.find({ status: "active" }, { skills: 1, _id: 0 });
    const skillSet = new Set();
    for (const job of jobs) {
        for (const skill of job.skills) {
            skillSet.add(skill.trim().toLowerCase());
        }
    }
    return [...skillSet].sort();
};
