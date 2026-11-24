
import mongoose ,{Schema} from "mongoose";

const CompanySchema=new Schema({
    name:{
        type:String,
        required:true,
    },
},{
    timestamps:true
})

export const Company=mongoose.model("Company",CompanySchema);
