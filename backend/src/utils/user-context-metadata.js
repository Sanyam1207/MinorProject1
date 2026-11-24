import { User } from "../models/user.models.js";
import { TPO } from "../models/tpo.models.js";

const COLLEGE_NAME =
    "Guru Gobind Singh Indraprastha University East Delhi Campus - University School of Automation and Robotics";

/**
 * Build role-aware context metadata for the Python AI backend.
 *
 * • **Student** – name, skills, cgpa, branch, and the fixed college name.
 * • **TPO**     – name, designation, and the fixed college name.
 *
 * @param {{ user: object, effectiveRole: string }} options
 * @returns {Promise<object>} metadata object ready to be spread into `meta_data`.
 */
export const buildUserContextMetadata = async ({ user, effectiveRole }) => {
    if (!user) return {};

    if (effectiveRole === "tpo") {
        // Populate the TPO document so we can read the designation field.
        let designation = "";
        if (user.TPO) {
            const tpoDoc = typeof user.TPO === "object" && user.TPO.designation !== undefined
                ? user.TPO
                : await TPO.findById(user.TPO).lean();
            designation = tpoDoc?.designation || "";
        }

        return {
            user_context: {
                role: "tpo",
                name: user.name || "",
                designation,
                college_name: COLLEGE_NAME,
            },
        };
    }

    // Default: student
    const student = user.student || {};
    const branch = user.branch || "";
    const skills = user.skills?.length ? user.skills : (student.skills || []);
    const cgpa = student.overallCGPA ?? user.cgpa ?? null;
    const name = student.name || user.name || "";

    return {
        user_context: {
            role: "student",
            name,
            skills,
            cgpa,
            branch,
            college_name: COLLEGE_NAME,
        },
    };
};
