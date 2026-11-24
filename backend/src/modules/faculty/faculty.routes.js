// /api/v1/faculty — teacher accounts managed by the TPO (or admin)
// (docs/contracts/AUTH-FACULTY.md §7.2, §7.5).
import { Router } from "express";
import { asyncHandler, fail, requireAuth, requireRole, send } from "../../core/http.js";
import {
    deactivateProvisioned,
    getProvisioned,
    inviteUser,
    listProvisioned,
    resetProvisionedPassword,
    updateProvisioned,
} from "./provisioning.service.js";
import { takeReveal } from "./reveal-store.js";

/** Router factory shared with /api/v1/recruiters (`kind` "teacher" | "company"). */
export const createProvisioningRouter = (kind, { withReveal = false } = {}) => {
    const router = Router();
    router.use(requireAuth, requireRole("tpo"));

    const collegeIdOf = (req) => req.query?.collegeId ?? req.body?.collegeId;

    router.get("/", asyncHandler(async (req, res) => {
        const { items, total, page, limit } = await listProvisioned({ actor: req.user, kind, query: req.query || {} });
        return send(res, { items, total, page, limit });
    }));

    router.post("/", asyncHandler(async (req, res) => {
        const result = await inviteUser({
            actor: req.user,
            kind,
            input: req.body,
            sendEmail: req.body?.sendEmail !== false,
            collegeId: collegeIdOf(req),
        });
        const noun = kind === "company" ? "Recruiter" : "Faculty member";
        const message = result.delivery === "email"
            ? `${noun} invited. Login details were emailed.`
            : `${noun} invited. Share the one-time temporary password securely.`;
        return send(res, result, message, 201);
    }));

    if (withReveal) {
        // Declared before "/:id" so "reveal" is never taken for an id.
        router.post("/reveal", asyncHandler(async (req, res) => {
            const revealed = takeReveal(req.body?.revealId, req.user._id);
            if (!revealed) {
                throw fail(
                    404,
                    "This password was already shown or has expired. Reset the password to issue a new one.",
                    "REVEAL_EXPIRED",
                );
            }
            return send(res, revealed, "Temporary password (shown once)");
        }));
    }

    router.get("/:id", asyncHandler(async (req, res) => {
        const user = await getProvisioned({ actor: req.user, kind, id: req.params.id, collegeId: collegeIdOf(req) });
        return send(res, { user });
    }));

    router.patch("/:id", asyncHandler(async (req, res) => {
        const user = await updateProvisioned({
            actor: req.user,
            kind,
            id: req.params.id,
            patch: req.body,
            collegeId: collegeIdOf(req),
        });
        return send(res, { user }, "Account updated");
    }));

    router.delete("/:id", asyncHandler(async (req, res) => {
        const user = await deactivateProvisioned({ actor: req.user, kind, id: req.params.id, collegeId: collegeIdOf(req) });
        return send(res, { user }, "Account deactivated");
    }));

    router.post("/:id/reset-password", asyncHandler(async (req, res) => {
        const result = await resetProvisionedPassword({
            actor: req.user,
            kind,
            id: req.params.id,
            sendEmail: req.body?.sendEmail !== false,
            collegeId: collegeIdOf(req),
        });
        const message = result.delivery === "email"
            ? "Password reset. New login details were emailed."
            : "Password reset. Share the one-time temporary password securely.";
        return send(res, result, message);
    }));

    return router;
};

export default createProvisioningRouter("teacher", { withReveal: true });
