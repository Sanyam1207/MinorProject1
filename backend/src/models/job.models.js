import mongoose ,{Schema} from "mongoose";

const ApplicationSchema=new Schema({
    student:{
        type:Schema.Types.ObjectId,
        ref:"Student",
        required:true,
    },
    status:{
        type:String,
        enum:["not applied","applied","rejected","inprogress","ineligible","eligible"],
        default:"not applied",
    },
},{ _id:false })

const JobSchema=new Schema({
    title:{
        type:String,
        required:true,
    },
    description:{
        type:String,
        required:true,
    },
    company:{
        type:Schema.Types.ObjectId,
        ref:"Company",
        required:true,
    },
    companyLogo:{
        type:String,
    },
    salary:{
        type:String,
        default:"not disclosed",
    },
    eligibleBranches:{
        type:[String],
        default:[],
    },
    location:{
        type:String,
        default:"",
    },
    employmentType:{
        type:String,
        default:"",
    },
    minimumCgpa:{
        type:Number,
    },
    maximumBacklogs:{
        type:Number,
    },
    graduationYears:{
        type:[String],
        default:[],
    },
    skills:{
        type:[String],
        default:[],
    },
    selectionProcess:{
        type:String,
        default:"",
    },
    applicationDeadline:{
        type:Date,
    },
    createdBy:{
        type:Schema.Types.ObjectId,
        ref:"User",
    },
    sourceSessionId:{
        type:String,
    },
    status:{
        type:String,
        enum:["active","closed","draft"],
        default:"active",
    },
    applications:{
        type:[ApplicationSchema],
        default:[],
    },
},{
    timestamps:true
})

JobSchema.index(
    { createdBy:1, sourceSessionId:1 },
    {
        unique:true,
        partialFilterExpression:{
            createdBy:{ $type:"objectId" },
            sourceSessionId:{ $type:"string" },
        },
    },
);

export const Job=mongoose.model("Job",JobSchema);
