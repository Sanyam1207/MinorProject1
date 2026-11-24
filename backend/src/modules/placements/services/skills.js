// Skill matching (docs/contracts/PLACEMENTS.md §2.6). Pure.

/** "Node.js" → "node", "React.js" → "react", "C++" → "c++". */
export const canonSkill = (value) => {
    let skill = String(value ?? "").toLowerCase().replace(/[^a-z0-9+#]/g, "");
    if (skill.length > 4 && skill.endsWith("js")) skill = skill.slice(0, -2);
    return skill;
};

/** user.skills ∪ user.projects[].skills (original spelling, deduped by canon). */
export const studentSkills = (user = {}) => {
    const all = [
        ...(Array.isArray(user.skills) ? user.skills : []),
        ...(Array.isArray(user.projects) ? user.projects.flatMap((project) => (Array.isArray(project?.skills) ? project.skills : [])) : []),
    ];
    const seen = new Set();
    const out = [];
    for (const skill of all) {
        const canon = canonSkill(skill);
        if (!canon || seen.has(canon)) continue;
        seen.add(canon);
        out.push(String(skill).trim());
    }
    return out;
};

/**
 * @returns {{matchPercentage: number|null, matchedSkills: string[], missingSkills: string[]}}
 */
export const skillMatch = (studentSkillList = [], jobSkills = []) => {
    const jobList = [];
    const seen = new Set();
    for (const skill of Array.isArray(jobSkills) ? jobSkills : []) {
        const canon = canonSkill(skill);
        if (!canon || seen.has(canon)) continue;
        seen.add(canon);
        jobList.push({ canon, label: String(skill).trim() });
    }
    if (jobList.length === 0) return { matchPercentage: null, matchedSkills: [], missingSkills: [] };
    const have = new Set((Array.isArray(studentSkillList) ? studentSkillList : []).map(canonSkill).filter(Boolean));
    const matchedSkills = [];
    const missingSkills = [];
    for (const { canon, label } of jobList) (have.has(canon) ? matchedSkills : missingSkills).push(label);
    return { matchPercentage: Math.round((100 * matchedSkills.length) / jobList.length), matchedSkills, missingSkills };
};
