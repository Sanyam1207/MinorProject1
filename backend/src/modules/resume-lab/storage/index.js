// Storage adapter (RESUME-BYOK.md §3).
//
//   getStorage(driverName = STORAGE_DRIVER) → driver
//   driver = { name, isConfigured(), put(key, buffer, {contentType, originalName}) → StoredFile,
//              get(storedFile) → Buffer, delete(storedFile), signedUrl?(storedFile, {expiresInSeconds, download}) }
//
// New files use STORAGE_DRIVER; existing files are ALWAYS read with the driver
// recorded on the StoredFile, so legacy Cloudinary PDFs stay readable.
import { fail } from "../../../core/http.js";
import { storageDriver } from "../config.js";
import { cloudinaryDriver } from "./cloudinary.driver.js";
import { localDriver } from "./local.driver.js";
import { uploadthingDriver } from "./uploadthing.driver.js";

const DRIVERS = Object.freeze({
    local: localDriver,
    cloudinary: cloudinaryDriver,
    uploadthing: uploadthingDriver,
});

/** The driver by name (default: STORAGE_DRIVER). Unconfigured → 503 STORAGE_UNAVAILABLE. */
export const getStorage = (driverName = storageDriver()) => {
    const driver = DRIVERS[driverName];
    if (!driver) throw fail(503, `Unknown storage driver "${driverName}"`, "STORAGE_UNAVAILABLE", { driver: driverName });
    if (!driver.isConfigured()) {
        throw fail(503, `The "${driverName}" file storage is not configured on this server`, "STORAGE_UNAVAILABLE", { driver: driverName });
    }
    return driver;
};

/** The driver that holds an existing StoredFile. */
export const storageFor = (storedFile) => getStorage(storedFile?.driver || "local");

/** Best-effort delete; failures are logged as orphans and never thrown. */
export const deleteStoredFile = async (storedFile) => {
    if (!storedFile?.key) return;
    try {
        await storageFor(storedFile).delete(storedFile);
    } catch (error) {
        console.warn(`[resume-lab] orphaned file ${storedFile.driver || "local"}:${storedFile.key} (${error?.message || error})`);
    }
};
