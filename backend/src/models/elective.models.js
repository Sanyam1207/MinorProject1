import mongoose ,{Schema} from "mongoose";

const ElectiveSchema=new Schema({
    name:{
        type:String,
        required:true,
        trim:true,
    },
    upvotedBy:[{
        type:Schema.Types.ObjectId,
        ref:"User",
    }],
    topics:{
        type:[String],
        default:[],
    },
},{
    timestamps:true,
})

export const Elective=mongoose.model("Elective",ElectiveSchema);
