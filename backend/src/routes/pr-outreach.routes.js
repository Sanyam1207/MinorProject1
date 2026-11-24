import { Router } from "express";
import { sendEmail } from "../controllers/pr-outreach.controller.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";

const router = Router();

router.route("/send-email").post(verifyJWT, sendEmail);

export default router;
