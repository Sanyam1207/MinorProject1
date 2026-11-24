import { AlumniConnection, AlumniProfile } from "../models/alumni.models.js";
import { Student } from "../models/student.models.js";

export const getStudentCollegeId = async (user) => {
    if (!user || user.role !== "student") return null;
    let collegeId = user.college || user.student?.college;
    if (!collegeId && user.student) {
        const studentId = user.student?._id || user.student;
        collegeId = (await Student.findById(studentId).select("college").lean())?.college;
    }
    return collegeId || null;
};

export const getAvailableAlumniForStudent = async (user) => {
    const collegeId = await getStudentCollegeId(user);
    if (!collegeId) return [];

    const profiles = await AlumniProfile.find({
        college: collegeId,
        acceptingRequests: true,
        onboardingComplete: true,
    }).limit(100).lean();

    const counts = await AlumniConnection.aggregate([
        { $match: { alumni: { $in: profiles.map((profile) => profile._id) }, status: { $in: ["pending", "accepted"] } } },
        { $group: { _id: "$alumni", count: { $sum: 1 } } },
    ]);
    const loadByAlumni = new Map(counts.map((entry) => [String(entry._id), entry.count]));

    return profiles
        .filter((profile) => profile.requestTypes?.length && (loadByAlumni.get(String(profile._id)) || 0) < profile.capacity)
        .map(({ user: _privateUserId, ...profile }) => profile);
};
