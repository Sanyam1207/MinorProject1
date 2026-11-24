import mongoose ,{Schema} from "mongoose";
const CollegeSchema=new Schema({
    name:{
        type:String,
        trim:true,
    },
    domain:{
        type:String,
        required:true,
        unique:true,
        lowercase:true,
        trim:true,
    },
    branches:{
        type:[String],
        default:[],
    },
    tpo:{
        type:Schema.Types.ObjectId,
        ref:"User",
        default:null,
    },
    tpos:[{
        type:Schema.Types.ObjectId,
        ref:"TPO",
    }],


},{
    timestamps:true,
})


export const College=mongoose.model("College",CollegeSchema);
