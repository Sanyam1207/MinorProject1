import mongoose ,{Schema} from "mongoose";

const ChatHistorySchema=new Schema({
    requestId:{
        type:String,
        required:true,
    },
    userQuery:{
        type:String,
        required:true,
    },
    aiResponse:{
        type:String,
    },
    sessionId:{
        type:String,
        required:true,
    },
},{ _id:false })

const QNASchema=new Schema({
    chatHistory:{
        type:[ChatHistorySchema],
        default:[],
    },
},{
    timestamps:true
})

export const QNA=mongoose.model("QNA",QNASchema);
