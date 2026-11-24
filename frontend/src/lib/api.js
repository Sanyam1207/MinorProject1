// Legacy API facade (FRONTEND.md §14.1).
//
// Keeps every historical function name and argument list, and still resolves
// with the FULL backend envelope `{statusCode, data, message, success}` so the
// existing callers (PROutreach, AlumniConnect, ResumeStudio, GGSIPU sync, …)
// keep reading `res.data`. Requests go through the shared `http` client
// (Bearer token, single-flight 401 refresh); failures are converted back into
// an axios-compatible error so `error.response?.data?.message` and
// `error.response.data.errors.includes("GMAIL_NOT_CONNECTED")` keep working.
//
// New code must use the feature modules in `src/lib/api/*.js` instead.
import axios from "axios";
import { API_BASE, API_ORIGIN } from "./config.js";
import { ApiClientError, http } from "./http.js";
import { getItem } from "./storage.js";

export { API_BASE, API_ORIGIN };

/** ApiClientError → axios-shaped error (no `response` for network failures, like axios). */
export const toLegacyError = (error) => {
  if (!(error instanceof ApiClientError)) return error;
  const legacy = new Error(error.message || "Request failed");
  legacy.name = "ApiError";
  legacy.status = error.status;
  legacy.code = error.code;
  legacy.details = error.details;
  if (error.status) {
    const details = error.details;
    const errors = Array.isArray(details) ? details : details ? [details] : [];
    legacy.response = {
      status: error.status,
      data: { success: false, message: error.message, errors, data: null },
    };
  }
  return legacy;
};

const request = (config) =>
  http({ ...config, raw: true }).catch((error) => {
    throw toLegacyError(error);
  });

const get = (url, config = {}) => request({ ...config, method: "get", url });
const post = (url, data = {}, config = {}) => request({ ...config, method: "post", url, data });
const put = (url, data = {}, config = {}) => request({ ...config, method: "put", url, data });
const patch = (url, data = {}, config = {}) => request({ ...config, method: "patch", url, data });
const id = (value) => encodeURIComponent(String(value ?? ""));

// GGSIPU captcha/connect need the captcha session cookie, so they stay on
// plain axios with credentials (and the Bearer header).
const authHeader = () => {
  const token = getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
};

export const api = {
  /** @deprecated use src/lib/api/auth.js `loginOrRegister` */
  loginOrRegister: (payload) => post("/auth/login-or-register", payload, { withCredentials: true }),
  getMe: () => get("/auth/me"),
  updateProfile: (payload) => patch("/auth/me", payload),

  // GGSIPU Exam Portal Sync (academic connector; enrollment + password + captcha)
  getGgsipuCaptcha: async () => {
    const res = await axios.get(`${API_BASE}/ggsipu/captcha`, {
      headers: authHeader(),
      responseType: "blob",
      withCredentials: true,
    });
    return URL.createObjectURL(res.data);
  },
  connectGgsipu: async ({ enrollment, password, captcha }) => {
    const res = await axios.post(
      `${API_BASE}/ggsipu/connect`,
      { enrollment, password, captcha },
      { headers: authHeader(), withCredentials: true },
    );
    return res.data;
  },

  /** @deprecated use src/lib/api/resumes.js */
  uploadResume: (formData) => post("/resume/upload", formData, { headers: { "Content-Type": "multipart/form-data" } }),
  /** @deprecated use src/lib/api/resumes.js */
  getResumeScore: () => get("/resume/score"),

  // Mock interview history — the route that exists is GET /interviews.
  getMyInterviews: () => get("/interviews?limit=20"),
  /** @deprecated no backend route; use getMyInterviews */
  getInterviewById: (interviewId) => get(`/interviews/${id(interviewId)}`),

  /** @deprecated use src/lib/api/placements.js */
  getJobs: () => get("/jobs"),
  /** @deprecated use src/lib/api/placements.js */
  getAllDrives: () => get("/jobs"),
  /** @deprecated use src/lib/api/placements.js */
  getMatchedDrives: () => get("/drives/matched"),
  /** @deprecated use src/lib/api/admin.js */
  createDrive: (payload) => post("/jobs", payload),
  /** @deprecated use src/lib/api/placements.js */
  applyToDrive: (driveId) => post(`/jobs/${id(driveId)}/apply`, {}),

  /** @deprecated use src/lib/api/placements.js */
  getTrainingPrograms: () => get("/training"),
  /** @deprecated use src/lib/api/placements.js */
  getMyTrainingPrograms: () => get("/training/my"),
  /** @deprecated use src/lib/api/placements.js */
  registerForTraining: (programId) => post(`/training/${id(programId)}/register`, {}),

  /** @deprecated use src/lib/api/placements.js */
  getMyOffers: () => get("/offers/my"),
  /** @deprecated use src/lib/api/placements.js */
  acceptOffer: (offerId) => post(`/offers/${id(offerId)}/accept`, {}),
  /** @deprecated use src/lib/api/placements.js */
  rejectOffer: (offerId, reason = "") => post(`/offers/${id(offerId)}/reject`, { reason }),
  /** @deprecated use src/lib/api/placements.js */
  withdrawOffer: (offerId, reason = "") => post(`/offers/${id(offerId)}/withdraw`, { reason }),
  /** @deprecated use src/lib/api/admin.js */
  getAllOffers: (params = {}) => get("/offers", { params }),
  /** @deprecated use src/lib/api/admin.js */
  createOffer: (payload) => post("/offers", payload),
  /** @deprecated use src/lib/api/admin.js */
  markOfferPlaced: (offerId) => post(`/offers/${id(offerId)}/place`, {}),
  /** @deprecated use src/lib/api/admin.js */
  tpoOverrideOffer: (offerId, payload) => post(`/offers/${id(offerId)}/override`, payload),
  /** @deprecated use src/lib/api/admin.js */
  getPlacementPolicy: () => get("/offers/policy"),
  /** @deprecated use src/lib/api/admin.js */
  savePlacementPolicy: (payload) => post("/offers/policy", payload),

  // PR & Outreach (Gmail send)
  sendPROutreachEmail: (payload) => post("/pr-outreach/send-email", payload),
  getGmailAuthorizeUrl: () => get("/auth/google/gmail/authorize-url"),
  disconnectGmail: () => post("/auth/google/gmail/disconnect", {}),

  // Alumni mentorship
  getAlumniColleges: () => get("/alumni/colleges"),
  getAlumniProfile: () => get("/alumni/profile"),
  saveAlumniProfile: (payload) => put("/alumni/profile", payload),
  /** @deprecated the alumni agent matches mentors; no UI calls this */
  discoverAlumni: () => get("/alumni/discover"),
  getAlumniConnections: () => get("/alumni/connections"),
  createAlumniConnection: (payload) => post("/alumni/connections", payload),
  updateAlumniConnection: (connectionId, status) => patch(`/alumni/connections/${id(connectionId)}`, { status }),
  getMentorshipMessages: (connectionId) => get(`/alumni/connections/${id(connectionId)}/messages`),
  sendMentorshipMessage: (connectionId, text) => post(`/alumni/connections/${id(connectionId)}/messages`, { text }),
  shareResumeWithAlumni: (connectionId, payload) => post(`/alumni/connections/${id(connectionId)}/share-resume`, payload),

  // Resume bank (generated PDFs; alumni sharing depends on it)
  getResumeBank: () => get("/resume-bank"),
  saveGeneratedResume: (payload) => post("/resume-bank/generated", payload, { timeout: 120000 }),
  getResumeAccess: (resumeId) => get(`/resume-bank/${id(resumeId)}/access`),
};
