import mongoose, { Schema } from "mongoose";

const AdditionalDocumentSchema = new Schema({
    documentName: {
        type: String,
        required: true,
    },
    documentLink: {
        type: String,
    },
    resumeReference: {
        type: Schema.Types.ObjectId,
        ref: "Resume",
    },
}, { _id: false })

const StudentSchema = new Schema({
    name: {
        type: String,
        required: true,

    },
    email: {
        type: String,
        required: true,

    },
    university: {
        type: String,
    },
    semester: {
        type: Number,
    },
    overallCGPA: {
        type: Number,
    },
    marksheetReferences: {
        type: [String],
        default: [],
    },
    skills: {
        type: [String],
        default: [],
    },
    certifications: {
        type: [String],
        default: [],
    },
    achievements: {
        type: [String],
        default: [],
    },
    mobileNumber: {
        type: Number,
    },
    college: {
        type: Schema.Types.ObjectId,
        ref: "College",
    },
    parentName: {
        type: String,
    },
    additionalDocuments: {
        type: [AdditionalDocumentSchema],
        default: [],
    },


}, {
    timestamps: true
})
export const Student = mongoose.model("Student", StudentSchema);
