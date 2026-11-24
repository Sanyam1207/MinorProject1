import { Apiresponse } from "../utils/api-response.js";
import asynchandler from "../utils/asynchandler.js";
const healthcheck=asynchandler(async(req,res)=>{
return res.status(200)
.json(new Apiresponse(200,"Server is running fine",{}));

})
export {healthcheck};