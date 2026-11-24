// The ONLY module that references the optional "baileys" package, and only via a
// dynamic import (docs/contracts/JOB-FEED.md §11.1). Resolves to the library, or
// null when it is not installed (`npm install --omit=optional`) or fails to load.
const defaultImporter = () => import("baileys");
let memo = null;

export const loadBaileys = async (importer = defaultImporter) => {
    if (importer === defaultImporter) {
        memo ||= (async () => {
            try {
                return await defaultImporter();
            } catch {
                return null;
            }
        })();
        return memo;
    }
    try {
        return await importer();
    } catch {
        return null;
    }
};

/** The default export is makeWASocket; some bundlings expose it as a named export instead. */
export const makeSocketFactory = (lib) => {
    if (typeof lib?.makeWASocket === "function") return lib.makeWASocket;
    if (typeof lib?.default === "function") return lib.default;
    if (typeof lib?.default?.default === "function") return lib.default.default;
    return null;
};
