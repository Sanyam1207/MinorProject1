import mongoose from "mongoose";
import DBConnect from "../src/db/db.js";
import { College } from "../src/models/college.models.js";
import { User } from "../src/models/user.models.js";
import { AlumniProfile } from "../src/models/alumni.models.js";

const DEMO_PASSWORD = "AlumniDemo123!";
const people = [
    { name: "Aarav Mehta", email: "aarav.alumni@example.com", branch: "Computer Science", graduationYear: 2020, company: "Amazon", currentRole: "Software Development Engineer II", location: "Bengaluru", skills: ["Python", "AWS", "System Design", "Data Structures"], mentoringTopics: ["Amazon interviews", "Backend engineering", "Resume review"], requestTypes: ["career-guidance", "resume-review", "mock-interview", "company-insights"], availability: "Saturday 11:00 AM–1:00 PM" },
    { name: "Nisha Kapoor", email: "nisha.alumni@example.com", branch: "Information Technology", graduationYear: 2019, company: "Microsoft", currentRole: "Senior Product Engineer", location: "Hyderabad", skills: ["Python", "Azure", "Product Engineering", "Leadership"], mentoringTopics: ["Career planning", "Technical interviews", "Women in technology"], requestTypes: ["career-guidance", "resume-review", "project-review", "mock-interview"], availability: "Wednesday 7:00–8:00 PM" },
    { name: "Rohan Verma", email: "rohan.alumni@example.com", branch: "Computer Science", graduationYear: 2021, company: "Flipkart", currentRole: "Machine Learning Engineer", location: "Bengaluru", skills: ["Python", "Machine Learning", "SQL", "MLOps"], mentoringTopics: ["ML careers", "Project review", "Interview preparation"], requestTypes: ["career-guidance", "project-review", "mock-interview", "company-insights"], availability: "Sunday 4:00–6:00 PM" },
    { name: "Simran Kaur", email: "simran.alumni@example.com", branch: "Electronics and Communication", graduationYear: 2018, company: "Adobe", currentRole: "Engineering Manager", location: "Noida", skills: ["Java", "System Design", "Mentoring", "Frontend"], mentoringTopics: ["Engineering leadership", "Higher education", "Career transitions"], requestTypes: ["career-guidance", "resume-review", "higher-education", "company-insights"], availability: "Friday 6:00–7:00 PM" },
];

await DBConnect();
const college = await College.findOneAndUpdate(
    { domain: "ipu.ac.in" },
    { $setOnInsert: { name: "Guru Gobind Singh Indraprastha University", domain: "ipu.ac.in", branches: ["Computer Science", "Information Technology", "Electronics and Communication"] } },
    { upsert: true, new: true },
);

for (const person of people) {
    let user = await User.findOne({ email: person.email });
    if (!user) user = await User.create({ name: person.name, email: person.email, password: DEMO_PASSWORD, role: "alumni", college: college._id, branch: person.branch });
    else await User.updateOne({ _id: user._id }, { $set: { name: person.name, role: "alumni", college: college._id, branch: person.branch } });
    await AlumniProfile.findOneAndUpdate(
        { user: user._id },
        { $set: { ...person, user: undefined, email: undefined, college: college._id, degree: "B.Tech", bio: `${person.name} mentors students with practical guidance drawn from work at ${person.company}.`, languages: ["English", "Hindi"], capacity: 3, acceptingRequests: true, onboardingComplete: true, verificationStatus: "unverified", isDemo: true } },
        { upsert: true, new: true, runValidators: true },
    );
}

console.log(`Seeded ${people.length} alumni. Demo password: ${DEMO_PASSWORD}`);
await mongoose.disconnect();
