import jwt from "jsonwebtoken";
import { User } from "../models/user.models.js";
import { College } from "../models/college.models.js";

export const getAuthenticatedUser = async (socket) => {
    const token = socket.handshake.auth?.token
        || socket.handshake.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (!token) return null;

    try {
        const { _id } = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
        return User.findById(_id).populate("student");
    } catch {
        return null;
    }
};

export const getEffectiveRole = (user, requestedRole) => {
    if (user?.role === "admin") return "tpo";
    return user?.role || requestedRole || "student";
};

export const buildProfile = (user, details = {}) => {
    if (!user) return { ...details };

    const student = user.student;
    return {
        student_id: student?._id?.toString() || user._id?.toString() || null,
        name: student?.name || user.name || "",
        email: student?.email || user.email || "",
        phone: student?.mobileNumber ? String(student.mobileNumber) : "",
        college: student?.university || "",
        branch: user.branch || details.branch || "",
        cgpa: student?.overallCGPA ?? user.cgpa ?? details.cgpa ?? null,
        active_backlogs: details.active_backlogs ?? details.activeBacklogs ?? null,
        tenth_percentage: details.tenth_percentage ?? details.tenthPercentage ?? null,
        twelfth_percentage: details.twelfth_percentage ?? details.twelfthPercentage ?? null,
        graduation_year: details.graduation_year ?? details.graduationYear ?? null,
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

export const getInstitutionContext = async (user, effectiveRole) => {
    const emailDomain = user?.email?.split("@")[1]?.toLowerCase();
    const college = emailDomain ? await College.findOne({ domain: emailDomain }).lean() : null;

    return {
        college_id: college?._id?.toString() || user?.college?.toString() || null,
        college_name: college?.name || college?.domain || emailDomain || "Unknown College",
        branches: college?.branches || [],
        ...(effectiveRole === "tpo" ? { tpo_user_id: user?._id?.toString() || null } : {}),
    };
};
