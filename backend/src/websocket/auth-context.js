// Socket identity and agent context (docs/contracts/AUTH-FACULTY.md §3.5,
// PLACEMENTS.md §8).
import jwt from "jsonwebtoken";
import { User, USER_AUTH_PROJECTION } from "../models/user.models.js";
import { College } from "../models/college.models.js";
// Registers the Student model used by populate("student").
import "../models/student.models.js";

const AGENT_TOOL_TOKEN_TYPE = "agent-tool";
const OBJECT_ID_RE = /^[a-f\d]{24}$/i;

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * The socket's user, or null (anonymous) when the token is missing or invalid,
 * is a copilot tool token, belongs to a missing or deactivated user, or was
 * revoked (`tv` ≠ tokenVersion). Never throws.
 */
export const getAuthenticatedUser = async (socket) => {
    const token = socket?.handshake?.auth?.token
        || socket?.handshake?.headers?.authorization?.replace(/^Bearer\s+/i, "");
    if (!token || typeof token !== "string") return null;

    try {
        const payload = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, { algorithms: ["HS256"] });
        if (!payload || typeof payload !== "object" || payload.typ === AGENT_TOOL_TOKEN_TYPE) return null;
        if (typeof payload._id !== "string" || !OBJECT_ID_RE.test(payload._id)) return null;
        const user = await User.findById(payload._id).select(USER_AUTH_PROJECTION).populate("student");
        if (!user || user.isActive === false) return null;
        if (Number(payload.tv ?? 0) !== Number(user.tokenVersion ?? 0)) return null;
        return user;
    } catch {
        return null;
    }
};

export const getEffectiveRole = (user, requestedRole) => {
    if (user?.role === "admin") return "tpo";
    return user?.role || requestedRole || "student";
};

const parseYear = (value) => {
    const year = Number.parseInt(value, 10);
    return Number.isFinite(year) ? year : null;
};

/**
 * Agent profile. Stored values win over client-supplied `details`
 * (PLACEMENTS.md §8): the client can fill gaps, never override the record.
 */
export const buildProfile = (user, rawDetails = {}) => {
    const details = isPlainObject(rawDetails) ? rawDetails : {};
    if (!user) return { ...details };

    const student = isPlainObject(user.student) && user.student.email !== undefined ? user.student : null;
    return {
        student_id: student?._id?.toString() || user._id?.toString() || null,
        name: student?.name || user.name || "",
        email: student?.email || user.email || "",
        phone: student?.mobileNumber ? String(student.mobileNumber) : "",
        role: user.role || null,
        college: user.collegeName || student?.university || "",
        branch: user.branch || details.branch || "",
        department: user.department || null,
        designation: user.designation || null,
        section: user.section || null,
        semester: user.semester ?? null,
        roll_number: user.rollNumber || null,
        cgpa: user.cgpa ?? student?.overallCGPA ?? details.cgpa ?? null,
        active_backlogs: user.activeBacklogs ?? details.active_backlogs ?? details.activeBacklogs ?? null,
        tenth_percentage: user.tenthPercentage ?? details.tenth_percentage ?? details.tenthPercentage ?? null,
        twelfth_percentage: user.twelfthPercentage ?? details.twelfth_percentage ?? details.twelfthPercentage ?? null,
        graduation_year: parseYear(user.passingYear) ?? details.graduation_year ?? details.graduationYear ?? null,
        category: details.category || null,
        skills: user.skills?.length ? user.skills : (student?.skills || details.skills || []),
        projects: user.projects?.length ? user.projects : (details.projects || []),
        experience: user.experience?.length ? user.experience : (details.experience || []),
        certifications: user.certifications?.length
            ? user.certifications
            : (student?.certifications || details.certifications || []),
        achievements: student?.achievements || details.achievements || [],
        github: user.socialLinks?.github || "",
        linkedin: user.socialLinks?.linkedin || "",
        portfolio: user.socialLinks?.portfolio || "",
    };
};

const collegeRef = (value) => {
    if (!value) return null;
    const id = value._id ?? value;
    return OBJECT_ID_RE.test(String(id)) ? String(id) : null;
};

/** The user's college: `user.college` first, then the email domain. */
export const getInstitutionContext = async (user, effectiveRole) => {
    const emailDomain = user?.email?.split("@")[1]?.toLowerCase() || null;
    const collegeId = collegeRef(user?.college);
    let college = collegeId ? await College.findById(collegeId).lean() : null;
    if (!college && emailDomain) college = await College.findOne({ domain: emailDomain }).lean();

    return {
        college_id: college?._id?.toString() || collegeId || null,
        college_name: college?.name || user?.collegeName || college?.domain || emailDomain || "Unknown College",
        college_domain: college?.domain || emailDomain || null,
        branches: college?.branches || [],
        departments: college?.departments || [],
        ...(effectiveRole === "tpo" ? { tpo_user_id: user?._id?.toString() || null } : {}),
    };
};
