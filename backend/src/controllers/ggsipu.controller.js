import axios from "axios";
import * as cheerio from "cheerio";
import { createHash } from "node:crypto";
import { User, USER_SAFE_PROJECTION } from "../models/user.models.js";
import { ApiError } from "../utils/api-error.js";
import { Apiresponse } from "../utils/api-response.js";
import asynchandler from "../utils/asynchandler.js";
import { AUTH_COOKIE_SAMESITE, NODE_ENV } from "../config/config.js";
import { College } from "../models/college.models.js";
import { canonicalBranch } from "../utils/branch.js";
import { findCollegeForEmail, linkStudentToCollege } from "../utils/student-college.js";

const GGSIPU_BASE_URL = "https://examweb.ggsipu.ac.in";
const SESSION_COOKIE = "ggsipu_session";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

// Same SameSite/Secure policy as the auth cookies (AUTH-FACULTY §13, §15).
const sessionCookieOptions = {
    httpOnly: true,
    secure: NODE_ENV === "production" || AUTH_COOKIE_SAMESITE === "none",
    sameSite: AUTH_COOKIE_SAMESITE,
    path: "/api/v1/ggsipu",
};
const clearSessionCookie = (res) => res.clearCookie(SESSION_COOKIE, sessionCookieOptions);

const hashPassword = (password, captcha) => {
    return createHash("sha256").update(password + captcha).digest("base64");
};

const gradePointForMarks = (marks) => {
    if (marks >= 90) return 10;
    if (marks >= 75) return 9;
    if (marks >= 65) return 8;
    if (marks >= 55) return 7;
    if (marks >= 50) return 6;
    if (marks >= 45) return 5;
    if (marks >= 40) return 4;
    return 0;
};

// Prefer a CGPA supplied by the upstream profile. When it is absent, derive
// an unweighted grade-point average from the available subject totals.
const extractCgpa = (stprofile, stresult) => {
    const upstreamCgpa = Number(stprofile?.cgpa ?? stprofile?.CGPA);
    if (Number.isFinite(upstreamCgpa) && upstreamCgpa >= 0 && upstreamCgpa <= 10) {
        return Math.round(upstreamCgpa * 100) / 100;
    }

    const gradePoints = (stresult || [])
        .filter(Array.isArray)
        .map((subject) => Number(subject[5]))
        .filter((marks) => Number.isFinite(marks) && marks >= 0 && marks <= 100)
        .map(gradePointForMarks);

    if (gradePoints.length === 0) return null;
    const average = gradePoints.reduce((sum, point) => sum + point, 0) / gradePoints.length;
    return Math.round(average * 100) / 100;
};

const extractJsessionId = (setCookieHeader) => {
    if (!setCookieHeader) return null;
    const cookieStr = Array.isArray(setCookieHeader) ? setCookieHeader[0] : String(setCookieHeader);
    const match = cookieStr?.match(/JSESSIONID=([^;]+)/);
    return match ? match[1] : null;
};

const extractErrorFromHtml = (html) => {
    const $ = cheerio.load(html || "");
    const h2Text = $("#content h2").first().text().trim() || $("h2").first().text().trim();
    return h2Text || "GGSIPU login failed. Please check your enrollment number, password, and captcha.";
};

// Fetches a fresh CAPTCHA image and initializes a short-lived GGSIPU session
const getCaptcha = asynchandler(async (req, res) => {
    let upstream;
    try {
        upstream = await axios.get(`${GGSIPU_BASE_URL}/web/CaptchaServlet`, {
            params: { t: Date.now() },
            responseType: "arraybuffer",
            headers: {
                Accept: "image/png,image/*",
                "User-Agent": USER_AGENT,
            },
            timeout: 8000,
            validateStatus: () => true,
        });
    } catch (err) {
        if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT") {
            throw new ApiError(504, "GGSIPU captcha request timed out. Please retry.");
        }
        throw new ApiError(503, "Cannot reach GGSIPU servers. Check your connection.");
    }

    if (upstream.status >= 400) {
        throw new ApiError(502, "Failed to generate GGSIPU captcha. Please refresh.");
    }

    const sessionId = extractJsessionId(upstream.headers["set-cookie"]);
    if (!sessionId) {
        throw new ApiError(502, "GGSIPU session initialization failed. Please retry.");
    }

    res.cookie(SESSION_COOKIE, sessionId, { ...sessionCookieOptions, maxAge: 5 * 60 * 1000 });
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "no-store");
    return res.status(200).send(Buffer.from(upstream.data));
});

// Logs into GGSIPU with the given credentials and pulls the full academic record.
// Always consumes (clears) the ggsipu_session cookie — it is single-use.
const loginAndFetchRecord = async (req, res, { enrollment, password, captcha }) => {
    if (!enrollment || !password || !captcha) {
        throw new ApiError(400, "Enrollment number, GGSIPU password, and captcha are all required");
    }

    const sessionId = req.cookies?.[SESSION_COOKIE];
    if (!sessionId) {
        throw new ApiError(401, "GGSIPU session expired. Please refresh the captcha and try again.");
    }

    const hashedPass = hashPassword(password, captcha);

    let loginRes;
    try {
        loginRes = await axios.post(
            `${GGSIPU_BASE_URL}/web/Login`,
            new URLSearchParams({
                username: enrollment.trim(),
                passwd: hashedPass,
                captcha,
            }).toString(),
            {
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    Cookie: `JSESSIONID=${sessionId}`,
                    Referer: `${GGSIPU_BASE_URL}/web/Login`,
                    Origin: GGSIPU_BASE_URL,
                    "User-Agent": USER_AGENT,
                },
                timeout: 10000,
                maxRedirects: 0,
                validateStatus: (status) => status === 302 || status === 200,
            }
        );
    } catch (err) {
        if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT") {
            throw new ApiError(504, "GGSIPU login timed out. Please retry.");
        }
        throw new ApiError(502, "GGSIPU portal is unreachable. Please try later.");
    }

    const location = loginRes.headers["location"] || "";
    const loginSucceeded = loginRes.status === 302 && location.includes("studenthome");

    if (!loginSucceeded) {
        clearSessionCookie(res);
        const rawHtml = typeof loginRes.data === "string" ? loginRes.data : "";
        throw new ApiError(401, extractErrorFromHtml(rawHtml));
    }

    const rotatedSessionId = extractJsessionId(loginRes.headers["set-cookie"]) || sessionId;

    let resultRes;
    try {
        resultRes = await axios.get(`${GGSIPU_BASE_URL}/web/StudentSearchProcess`, {
            params: { flag: 2, euno: 100 },
            headers: {
                Cookie: `JSESSIONID=${rotatedSessionId}`,
                Accept: "application/json,text/html",
                Referer: `${GGSIPU_BASE_URL}/web/student/studenthome.jsp`,
                "User-Agent": USER_AGENT,
            },
            timeout: 15000,
            validateStatus: () => true,
        });
    } catch (err) {
        if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT") {
            throw new ApiError(504, "GGSIPU academic record request timed out. Please retry.");
        }
        throw new ApiError(502, "GGSIPU portal is unreachable while fetching your academic record.");
    } finally {
        clearSessionCookie(res);
    }

    const raw = typeof resultRes.data === "string" ? resultRes.data : JSON.stringify(resultRes.data);

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new ApiError(502, "Unexpected response from GGSIPU while fetching your academic record.");
    }

    if (!parsed.stprofile || !Array.isArray(parsed.stresult)) {
        throw new ApiError(502, "GGSIPU returned an incomplete academic record. Please retry.");
    }

    return parsed;
};

// Authenticated students only: re-syncs the academic record of the signed-in
// account. GGSIPU is an optional academic-sync connector, never a login
// (AUTH-FACULTY §15). Linking sets ggsipuLinked, which locks self-edits of
// cgpa/branch (§6.2).
const connectGgsipu = asynchandler(async (req, res) => {
    const { enrollment, password, captcha } = req.body;
    const { stprofile, stresult, header } = await loginAndFetchRecord(req, res, { enrollment, password, captcha });
    const cgpa = extractCgpa(stprofile, stresult);
    const enrollmentNo = String(stprofile.nrollno ?? "").trim();
    if (!enrollmentNo) {
        throw new ApiError(502, "GGSIPU returned an incomplete academic record. Please retry.");
    }

    const alreadyLinked = await User.exists({ ggsipuEnrollment: enrollmentNo, _id: { $ne: req.user._id } });
    if (alreadyLinked) {
        throw new ApiError(409, "This GGSIPU enrollment is already linked to another account", [{ code: "ENROLLMENT_ALREADY_LINKED" }]);
    }

    const academicFields = {
        branch: canonicalBranch(stprofile.prgname) || undefined,
        ggsipuLinked: true,
        ggsipuEnrollment: enrollmentNo,
        ggsipuProfile: stprofile,
        ggsipuAcademicRecord: { header: header || null, subjects: stresult },
        ggsipuLastSyncedAt: new Date(),
    };
    if (!academicFields.branch) delete academicFields.branch;
    if (cgpa !== null) academicFields.cgpa = cgpa;

    const updatedUser = await User.findByIdAndUpdate(
        req.user._id,
        { $set: academicFields },
        { returnDocument: "after", runValidators: true }
    ).select(USER_SAFE_PROJECTION);

    if (!updatedUser) {
        throw new ApiError(404, "User not found", [{ code: "NOT_FOUND" }]);
    }

    const college = (updatedUser.college ? await College.findById(updatedUser.college) : null)
        || await findCollegeForEmail(updatedUser.email);
    if (!college) {
        throw new ApiError(400, "INVALID DOMAIN: No college is registered for the user email domain", [{ code: "INVALID_DOMAIN" }]);
    }
    await linkStudentToCollege(updatedUser, college);

    return res
        .status(200)
        .json(new Apiresponse(200, { user: updatedUser }, "GGSIPU account connected and academic record synced"));
});

export { getCaptcha, connectGgsipu };
