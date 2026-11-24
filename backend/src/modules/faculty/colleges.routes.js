// /api/v1/colleges (docs/contracts/AUTH-FACULTY.md §8).
//   GET   /mine  any signed-in user with a college
//   PATCH /mine  tpo (admin with collegeId or their own college)
//   GET   /      admin only
//   POST  /      admin only
import { Router } from "express";
import { asyncHandler, fail, requireAuth, requireRole, send } from "../../core/http.js";
import { College } from "../../models/college.models.js";
import { canonicalBranchList } from "../../utils/branch.js";
import { resolveActorCollege, toCollegeDTO } from "./provisioning.service.js";

const router = Router();

const LIST_MAX = 30;
const DOMAIN_RE = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

const adminOnly = (req, _res, next) => {
    if (req.user?.role === "admin") return next();
    return next(fail(403, "This action requires the admin role", "FORBIDDEN"));
};

const validation = (field, message) => fail(400, message, "VALIDATION", { field });

const collegeName = (value, { required }) => {
    if (value === undefined && !required) return undefined;
    const text = typeof value === "string" ? value.trim() : "";
    if (text.length < 2 || text.length > 120) throw validation("name", "College name must be 2–120 characters");
    return text;
};

const branchList = (value, field) => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) throw validation(field, `${field} must be a list`);
    if (value.some((entry) => typeof entry !== "string" || entry.trim().length > 60)) {
        throw validation(field, `Each ${field} entry must be text of at most 60 characters`);
    }
    const list = canonicalBranchList(value);
    if (list.length > LIST_MAX) throw validation(field, `${field} can have at most ${LIST_MAX} entries`);
    return list;
};

const loadCollegeDTO = async (id) => {
    const college = await College.findById(id).populate({ path: "tpo", select: "name email" }).lean();
    return college ? toCollegeDTO(college) : null;
};

router.get("/mine", requireAuth, asyncHandler(async (req, res) => {
    let collegeId = req.user.college;
    if (!collegeId) {
        const domain = typeof req.user.email === "string" ? req.user.email.split("@")[1]?.toLowerCase() : null;
        const byDomain = domain ? await College.findOne({ domain }).select("_id").lean() : null;
        collegeId = byDomain?._id;
    }
    const college = collegeId ? await loadCollegeDTO(collegeId) : null;
    if (!college) throw fail(404, "Your account is not linked to a college", "NOT_FOUND");
    return send(res, { college });
}));

router.patch("/mine", requireAuth, requireRole("tpo"), asyncHandler(async (req, res) => {
    const body = req.body || {};
    const update = {};
    const name = collegeName(body.name, { required: false });
    if (name !== undefined) update.name = name;
    const branches = branchList(body.branches, "branches");
    if (branches !== undefined) update.branches = branches;
    const departments = branchList(body.departments, "departments");
    if (departments !== undefined) update.departments = departments;
    if (Object.keys(update).length === 0) throw fail(400, "Provide name, branches or departments", "VALIDATION");

    const scope = await resolveActorCollege(req.user, body.collegeId ?? req.query?.collegeId, { purpose: "create" });
    await College.updateOne({ _id: scope._id }, { $set: update });
    return send(res, { college: await loadCollegeDTO(scope._id) }, "College updated");
}));

router.get("/", requireAuth, adminOnly, asyncHandler(async (_req, res) => {
    const colleges = await College.find({}).sort({ name: 1, domain: 1 }).populate({ path: "tpo", select: "name email" }).lean();
    return send(res, { items: colleges.map(toCollegeDTO) });
}));

router.post("/", requireAuth, adminOnly, asyncHandler(async (req, res) => {
    const body = req.body || {};
    const name = collegeName(body.name, { required: true });
    const domain = typeof body.domain === "string" ? body.domain.trim().toLowerCase().replace(/^@/, "") : "";
    if (!DOMAIN_RE.test(domain)) throw validation("domain", "Enter a valid email domain, e.g. demo.edu");
    const branches = branchList(body.branches, "branches") ?? [];
    const departments = branchList(body.departments, "departments") ?? [];

    if (await College.exists({ domain })) {
        throw fail(409, "A college with this domain already exists", "DUPLICATE", { keys: ["domain"] });
    }
    const created = await College.create({ name, domain, branches, departments });
    return send(res, { college: await loadCollegeDTO(created._id) }, "College created", 201);
}));

export default router;
