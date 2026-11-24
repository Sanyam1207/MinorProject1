// Resume picker data for the apply dialog. The resume module owns the
// resume API; this reads it defensively: GET /resumes (catalog) first, then
// the legacy GET /resume-bank, else an empty list (the backend then attaches
// the primary resume, if any).
import { http } from "../../lib/http.js";

const normalize = (raw) => {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw._id ?? raw.id ?? "");
  if (!id) return null;
  return {
    id,
    title: raw.title || "Untitled resume",
    version: raw.version ?? null,
    kind: raw.kind || null,
    status: raw.status || "active",
    isPrimary: raw.isPrimary === true,
  };
};

const pick = (data) => {
  if (Array.isArray(data)) return data;
  for (const key of ["resumes", "items", "data"]) if (Array.isArray(data?.[key])) return data[key];
  return [];
};

/** → { items: [{id, title, version, kind, isPrimary}], primaryId, unavailable } */
export async function listResumeOptions() {
  for (const path of ["/resumes", "/resume-bank"]) {
    try {
      const data = await http.get(path);
      const items = pick(data).map(normalize).filter((item) => item && item.status === "active");
      const primaryId = data?.primaryId ? String(data.primaryId) : items.find((item) => item.isPrimary)?.id ?? null;
      return { items, primaryId, unavailable: false };
    } catch (error) {
      if (![404, 405, 501].includes(error?.status)) return { items: [], primaryId: null, unavailable: true, error };
    }
  }
  return { items: [], primaryId: null, unavailable: true };
}
