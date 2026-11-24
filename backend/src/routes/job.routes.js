import { Router } from "express";
import { getJobs } from "../controllers/job.controller.js";

const router = Router();

router.route("/").get(getJobs);

export default router;
