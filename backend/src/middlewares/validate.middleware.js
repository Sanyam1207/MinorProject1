import { ExpressValidator, validationResult } from "express-validator";
import { ApiError } from "../utils/api-error.js";
export const validate=(req,res,next)=>{
const errors=validationResult(req);
if(errors.isEmpty()){
    return next()
}
let extractederrors=[]
errors.array().map((err)=>{
    extractederrors.push({[err.path]:err.msg})
})
console.log(extractederrors)
throw new ApiError(422,"received data is not valid",extractederrors)
};
