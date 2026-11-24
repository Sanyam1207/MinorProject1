import mongoose ,{Schema} from "mongoose";
const AllowedDomainsSchema=new Schema({
domain:{
    type:String,
    
}
})
 export const allowedDomains=mongoose.model("allowedDomains",AllowedDomainsSchema);