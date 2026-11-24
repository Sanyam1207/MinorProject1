import { Job } from "../models/job.models.js";
import "../models/company.models.js";
import { Apiresponse } from "../utils/api-response.js";
import asynchandler from "../utils/asynchandler.js";

const getJobs = asynchandler(async (req, res) => {
    const jobs = await Job.find()
        .populate("company", "name")
        .sort({ createdAt: -1 });

    return res
        .status(200)
        .json(new Apiresponse(200, jobs, "Jobs fetched successfully"));
});

export { getJobs };
