// Helpers shared by the placements routers.
import { assertObjectId } from "../../../core/http.js";

/** Validate `:name` path params as ObjectIds (400 VALIDATION before any handler runs). */
export const validateIdParam = (router, name, field = name) => {
    router.param(name, (_req, _res, next, value) => {
        try {
            assertObjectId(value, field);
            next();
        } catch (error) {
            next(error);
        }
    });
};

/** Send a CSV download. */
export const sendCsv = (res, { filename, csv }) => {
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="${filename.replace(/["\\\r\n]/g, "")}"`);
    return res.status(200).send(csv);
};
