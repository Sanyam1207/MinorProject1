import jwt from "jsonwebtoken";
import { ApiError } from "../utils/api-error.js";
import asynchandler from "../utils/asynchandler.js";
import { User } from "../models/user.models.js";

export const verifyJWT=asynchandler(async(req,res,next)=>{
    const token=req.cookies?.accessToken||req.header("Authorization")?.replace("Bearer ","");

    if(!token){
        throw new ApiError(401,"Unauthorized request");
    }

    let decodedToken;
    try{
        decodedToken=jwt.verify(token,process.env.ACCESS_TOKEN_SECRET);
    }catch(error){
        throw new ApiError(401,"Invalid or expired access token");
    }

    const user=await User.findById(decodedToken?._id).select("-password -passwordResetToken -passwordResetExpiry");
    if(!user){
        throw new ApiError(401,"Invalid access token");
    }

    req.user=user;
    next();
})
