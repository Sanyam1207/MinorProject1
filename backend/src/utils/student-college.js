import { College } from "../models/college.models.js";
import { Student } from "../models/student.models.js";

export const findCollegeForEmail = async (email) => {
    const domain = email.trim().toLowerCase().split("@")[1];

    if (!domain) return null;

    return College.findOne({ domain });
};

export const linkStudentToCollege = async (user, college) => {
    let student = user.student ? await Student.findById(user.student) : null;

    if (!student) {
        student = await Student.findOne({ email: user.email });
    }

    if (!student) {
        student = await Student.create({
            name: user.name,
            email: user.email,
            college: college._id,
        });
    } else {
        student.name = user.name;
        student.email = user.email;
        student.college = college._id;
        await student.save();
    }

    const studentChanged = !user.student || !user.student.equals(student._id);
    const collegeChanged = !user.college || !user.college.equals(college._id);
    if (studentChanged || collegeChanged) {
        user.student = student._id;
        user.college = college._id;
        await user.save({ validateBeforeSave: false });
    }

    return student;
};
