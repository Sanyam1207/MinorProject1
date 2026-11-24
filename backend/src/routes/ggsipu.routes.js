import { Router } from "express";
import { getCaptcha, connectGgsipu } from "../controllers/ggsipu.controller.js";
import { requireRole } from "../core/http.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";

const router = Router();

// GGSIPU is an optional academic-sync connector for signed-in students, never
// an auth dependency (docs/contracts/AUTH-FACULTY.md §15). Other roles: 403 FORBIDDEN.
router.route("/captcha").get(verifyJWT, requireRole("student"), getCaptcha);
router.route("/connect").post(verifyJWT, requireRole("student"), connectGgsipu);

export default router;
