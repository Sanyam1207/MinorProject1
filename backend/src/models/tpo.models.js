import mongoose , {Schema} from "mongoose";
const TPOSchema=new Schema({
    name:{
        type:String,
        required:true,
    },
    email:{
        type:String,
        required:true,
    },
    profilePhoto:{
        type:String,
    },
    designation:{
        type:String,
    },

},{
    timestamps:true
})
export const TPO=mongoose.model("TPO",TPOSchema)