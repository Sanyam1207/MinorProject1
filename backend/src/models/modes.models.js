import mongoose ,{Schema} from "mongoose";
const ModeEmailsSchema=new Schema({
    modeName:{
        type:String,
        required:true,
    },
    emails:{
        type:[String],
        default:[],
    },
},{
    timestamps:true
})
export const ModeEmails=mongoose.model("ModeEmails",ModeEmailsSchema);
