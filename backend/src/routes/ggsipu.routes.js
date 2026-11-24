import { Router } from "express";
import { getCaptcha, connectGgsipu } from "../controllers/ggsipu.controller.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";

const router = Router();

// GGSIPU is an optional academic-profile connector, never an auth dependency.
router.route("/captcha").get(verifyJWT, getCaptcha);
router.route("/connect").post(verifyJWT, connectGgsipu);

export default router;
