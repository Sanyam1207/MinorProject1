import crypto from "crypto";
import jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";
import { User } from "../models/user.models.js";
import { College } from "../models/college.models.js";
import { ApiError } from "../utils/api-error.js";
import { Apiresponse } from "../utils/api-response.js";
import asynchandler from "../utils/asynchandler.js";
import { CLIENT_ID, NODE_ENV, TPO_EMAIL, TPO_INITIAL_PASSWORD } from "../config/config.js";
import { findCollegeForEmail, linkStudentToCollege } from "../utils/student-college.js";

const googleClient = new OAuth2Client(CLIENT_ID);

export const cookieOptions = {
    httpOnly: true,
    secure: NODE_ENV === "production",
    sameSite: "strict",
};

export const generateAccessAndRefreshTokens = async (userId) => {
    const user = await User.findById(userId);
    if (!user) {
        throw new ApiError(404, "User not found while generating tokens");
    }
    const accessToken = user.generateAccessToken();
    const refreshToken = user.generateRefreshToken();

    user.refreshToken = refreshToken;
    await user.save({ validateBeforeSave: false });

    return { accessToken, refreshToken };
};

const matchesConfiguredTpoPassword = (password) => {
    if (!TPO_INITIAL_PASSWORD || typeof password !== "string") return false;
    const supplied = Buffer.from(password);
    const configured = Buffer.from(TPO_INITIAL_PASSWORD);
    return supplied.length === configured.length && crypto.timingSafeEqual(supplied, configured);
};

const ensureCollegeTpoSlot = async (college, userId) => {
    if (college.tpo && college.tpo.toString() !== userId.toString()) {
        throw new ApiError(409, "This college already has a registered TPO account");
    }
    if (college.tpo) return;

    const claimedCollege = await college.constructor.findOneAndUpdate(
        {
            _id: college._id,
            $or: [{ tpo: null }, { tpo: { $exists: false } }],
        },
        { $set: { tpo: userId } },
        { new: true },
    );
    if (!claimedCollege) {
        throw new ApiError(409, "This college already has a registered TPO account");
    }
};

// Primary authentication: an IPU email/password logs an existing user in or
// creates a new local account when the email has not been seen before.
const loginOrRegister = asynchandler(async (req, res) => {
    const { email, password, role = "student" } = req.body;

    if (!email || !password) {
        throw new ApiError(400, "Email and password are required");
    }

    const cleanEmail = email.trim().toLowerCase();
    const requestedRole = ["tpo", "alumni"].includes(role) ? role : "student";

    let college = await findCollegeForEmail(cleanEmail);
    const isApprovedTpoBootstrap = requestedRole === "tpo"
        && cleanEmail === TPO_EMAIL
        && matchesConfiguredTpoPassword(password);

    // Demo bootstrap: the preconfigured TPO may initialize its college on the
    // first valid login. Student registrations still require a pre-existing
    // college-domain record.
    if (!college && isApprovedTpoBootstrap) {
        const domain = cleanEmail.split("@")[1];
        college = await College.findOneAndUpdate(
            { domain },
            {
                $setOnInsert: {
                    name: domain.split(".")[0].toUpperCase(),
                    domain,
                    branches: [],
                },
            },
            { new: true, upsert: true, setDefaultsOnInsert: true },
        );
    }
    if (!college && requestedRole !== "alumni") {
        throw new ApiError(400, "INVALID DOMAIN: Use an email domain registered to a college");
    }

    let user = await User.findOne({ email: cleanEmail });

    if (user) {
        if (user.role !== requestedRole) {
            throw new ApiError(403, `This email is registered as a ${user.role} account`);
        }
        // EXISTING USER: Verify password and log in
        if (!user.password) {
            throw new ApiError(400, "This account was created using Google Sign-In. Please continue with Google.");
        }

        const isPasswordValid = await user.isPasswordCorrect(password);
        if (!isPasswordValid) {
            console.log(`❌ [AUTH LOGIN FAILED] Incorrect password attempt for: ${cleanEmail}`);
            throw new ApiError(401, "Invalid password for existing account");
        }

        if (requestedRole === "tpo") {
            await ensureCollegeTpoSlot(college, user._id);
            if (!user.college || user.college.toString() !== college._id.toString()) {
                user.college = college._id;
                await user.save({ validateBeforeSave: false });
            }
        } else if (requestedRole === "student") {
            await linkStudentToCollege(user, college);
        }

        const { accessToken, refreshToken } = await generateAccessAndRefreshTokens(user._id);
        const loggedInUser = await User.findById(user._id).select("-password -refreshToken -passwordResetToken -passwordResetExpiry");

        console.log(`
=====================================================
🔑 [EXISTING USER LOGGED IN FROM DB]
=====================================================
👤 User ID:   ${user._id}
📧 Email:     ${cleanEmail}
🛡️ Auth Type: Local Password
⏰ Timestamp: ${new Date().toLocaleString()}
=====================================================
        `);

        return res.status(200)
            .cookie("accessToken", accessToken, cookieOptions)
            .cookie("refreshToken", refreshToken, cookieOptions)
            .json(new Apiresponse(200, { user: loggedInUser, accessToken, refreshToken, isNewUser: false }, "Existing user logged in successfully"));
    } else {
        if (requestedRole === "tpo") {
            if (!TPO_EMAIL || !TPO_INITIAL_PASSWORD) {
                throw new ApiError(503, "TPO demo credentials are not configured on the backend");
            }
            if (cleanEmail !== TPO_EMAIL || !matchesConfiguredTpoPassword(password)) {
                throw new ApiError(403, "Email or initial password is not approved for TPO registration");
            }
            if (college.tpo) {
                throw new ApiError(409, "This college already has a registered TPO account");
            }
        }

        // NEW USER: Register the selected account type in MongoDB
        const userName = cleanEmail
            .split("@")[0]
            .replace(/[._-]+/g, " ")
            .replace(/\b\w/g, (letter) => letter.toUpperCase());
        user = await User.create({
            name: userName,
            email: cleanEmail,
            password,
            role: requestedRole,
            authProvider: "local",
            college: requestedRole === "tpo" ? college._id : undefined,
        });
        if (requestedRole === "tpo") {
            try {
                await ensureCollegeTpoSlot(college, user._id);
            } catch (error) {
                await User.deleteOne({ _id: user._id });
                throw error;
            }
        } else if (requestedRole === "student") {
            await linkStudentToCollege(user, college);
        }

        const { accessToken, refreshToken } = await generateAccessAndRefreshTokens(user._id);
        const createdUser = await User.findById(user._id).select("-password -refreshToken -passwordResetToken -passwordResetExpiry");

        console.log(`
=====================================================
🆕 [NEW USER REGISTERED IN DATABASE]
=====================================================
👤 Name:      ${userName}
📧 Email:     ${cleanEmail}
🛡️ Role:      ${requestedRole}
🔑 Auth Type: Local Password
⏰ Timestamp: ${new Date().toLocaleString()}
=====================================================
        `);

        return res.status(201)
            .cookie("accessToken", accessToken, cookieOptions)
            .cookie("refreshToken", refreshToken, cookieOptions)
            .json(new Apiresponse(201, { user: createdUser, accessToken, refreshToken, isNewUser: true }, "New user registered and logged in successfully"));
    }
});

// simple email/password registration
const registerUser = asynchandler(async (req, res) => {
    const { name, email, password } = req.body;

    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
        throw new ApiError(409, "User with this email already exists");
    }

    const user = await User.create({
        name,
        email: email.toLowerCase(),
        password,
        authProvider: "local",
    });

    const { accessToken, refreshToken } = await generateAccessAndRefreshTokens(user._id);
    const createdUser = await User.findById(user._id).select("-password -refreshToken -passwordResetToken -passwordResetExpiry");

    console.log(`
=====================================================
🆕 [NEW USER REGISTERED VIA REGISTER ENDPOINT]
=====================================================
👤 Name:      ${name}
📧 Email:     ${user.email}
⏰ Timestamp: ${new Date().toLocaleString()}
=====================================================
    `);

    return res.status(201)
        .cookie("accessToken", accessToken, cookieOptions)
        .cookie("refreshToken", refreshToken, cookieOptions)
        .json(new Apiresponse(201, { user: createdUser, accessToken, refreshToken }, "User registered successfully"));
});

// simple email/password login
const loginUser = asynchandler(async (req, res) => {
    return loginOrRegister(req, res);
});

// login/register via Google Identity Services
const googleAuth = asynchandler(async (req, res) => {
    const { idToken, email, name, picture, googleId, role = "student" } = req.body;

    let userEmail = email;
    let userName = name;
    let userPicture = picture;
    let userGoogleId = googleId;

    if (idToken && CLIENT_ID) {
        try {
            const ticket = await googleClient.verifyIdToken({
                idToken,
                audience: CLIENT_ID,
            });
            const payload = ticket.getPayload();
            userEmail = payload.email;
            userName = payload.name;
            userPicture = payload.picture;
            userGoogleId = payload.sub;
        } catch (error) {
            console.warn("Google token verification warning, fallback to payload:", error.message);
        }
    }

    if (!userEmail) {
        throw new ApiError(400, "Email is required for Google OAuth");
    }

    const cleanEmail = userEmail.trim().toLowerCase();

    const college = role === "student" ? await findCollegeForEmail(cleanEmail) : null;
    if (role === "student" && !college) {
        throw new ApiError(400, "INVALID DOMAIN: Student Google OAuth requires an email domain registered to a college");
    }

    let user = await User.findOne({ email: cleanEmail });

    if (!user) {
        user = await User.create({
            name: userName || cleanEmail.split("@")[0].toUpperCase(),
            email: cleanEmail,
            profile: userPicture,
            authProvider: "google",
            googleId: userGoogleId || "google_" + Date.now(),
        });

        console.log(`
=====================================================
🆕 [NEW USER REGISTERED VIA GOOGLE OAUTH]
=====================================================
👤 Name:      ${user.name}
📧 Email:     ${cleanEmail}
🔑 Auth Type: Google OAuth
⏰ Timestamp: ${new Date().toLocaleString()}
=====================================================
        `);
    } else {
        if (!user.googleId) {
            user.googleId = userGoogleId || "google_" + Date.now();
            if (!user.profile) user.profile = userPicture;
            await user.save({ validateBeforeSave: false });
        }

        console.log(`
=====================================================
🔑 [EXISTING USER LOGGED IN VIA GOOGLE OAUTH]
=====================================================
👤 User ID:   ${user._id}
📧 Email:     ${cleanEmail}
🔑 Auth Type: Google OAuth
⏰ Timestamp: ${new Date().toLocaleString()}
=====================================================
        `);
    }

    if (role === "student") {
        await linkStudentToCollege(user, college);
    }

    const { accessToken, refreshToken } = await generateAccessAndRefreshTokens(user._id);
    const loggedInUser = await User.findById(user._id).select("-password -refreshToken -passwordResetToken -passwordResetExpiry");

    return res.status(200)
        .cookie("accessToken", accessToken, cookieOptions)
        .cookie("refreshToken", refreshToken, cookieOptions)
        .json(new Apiresponse(200, { user: loggedInUser, accessToken, refreshToken }, "Logged in with Google successfully"));
});

const logoutUser = asynchandler(async (req, res) => {
    await User.findByIdAndUpdate(
        req.user._id,
        { $unset: { refreshToken: 1 } },
    );

    return res.status(200)
        .clearCookie("accessToken", cookieOptions)
        .clearCookie("refreshToken", cookieOptions)
        .json(new Apiresponse(200, {}, "Logged out successfully"));
});

const refreshAccessToken = asynchandler(async (req, res) => {
    const incomingRefreshToken = req.cookies?.refreshToken || req.body?.refreshToken;

    if (!incomingRefreshToken) {
        throw new ApiError(401, "Unauthorized request");
    }

    let decodedToken;
    try {
        decodedToken = jwt.verify(incomingRefreshToken, process.env.REFRESH_TOKEN_SECRET);
    } catch (error) {
        throw new ApiError(401, "Invalid or expired refresh token");
    }

    const user = await User.findById(decodedToken?._id);
    if (!user || incomingRefreshToken !== user.refreshToken) {
        throw new ApiError(401, "Refresh token is invalid or has been used");
    }

    const { accessToken, refreshToken } = await generateAccessAndRefreshTokens(user._id);

    return res.status(200)
        .cookie("accessToken", accessToken, cookieOptions)
        .cookie("refreshToken", refreshToken, cookieOptions)
        .json(new Apiresponse(200, { accessToken, refreshToken }, "Access token refreshed"));
});

const forgotPassword = asynchandler(async (req, res) => {
    const { email } = req.body;

    const user = await User.findOne({ email: email.toLowerCase() });

    if (!user || !user.password) {
        return res.status(200)
            .json(new Apiresponse(200, {}, "If an account with that email exists, a reset link has been sent"));
    }

    const resetToken = user.generatePasswordResetToken();
    await user.save({ validateBeforeSave: false });

    console.log(`Password reset token for ${user.email}: ${resetToken}`);

    return res.status(200)
        .json(new Apiresponse(200, {}, "If an account with that email exists, a reset link has been sent"));
});

const resetPassword = asynchandler(async (req, res) => {
    const { token } = req.params;
    const { password } = req.body;

    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    const user = await User.findOne({
        passwordResetToken: hashedToken,
        passwordResetExpiry: { $gt: Date.now() },
    });

    if (!user) {
        throw new ApiError(400, "Reset token is invalid or has expired");
    }

    user.password = password;
    user.passwordResetToken = undefined;
    user.passwordResetExpiry = undefined;
    await user.save();

    return res.status(200)
        .json(new Apiresponse(200, {}, "Password reset successfully"));
});

const getCurrentUser = asynchandler(async (req, res) => {
    return res
        .status(200)
        .json(new Apiresponse(200, req.user, "Current user fetched successfully"));
});

const updateProfile = asynchandler(async (req, res) => {
    const { name, profile, branch, collegeName, passingYear, cgpa, skills, projects, certifications, experience, careerPreferences, socialLinks } = req.body;

    if (!name && !profile && !branch && !collegeName && !passingYear && cgpa === undefined && !skills && !projects && !certifications && !experience && !careerPreferences && !socialLinks) {
        throw new ApiError(400, "Please provide at least one field to update");
    }

    const updateFields = {};
    if (name) updateFields.name = name;
    if (profile) updateFields.profile = profile;
    if (branch) updateFields.branch = branch;
    if (collegeName !== undefined) updateFields.collegeName = collegeName;
    if (passingYear !== undefined) updateFields.passingYear = passingYear;
    if (cgpa !== undefined) updateFields.cgpa = cgpa;
    if (skills) updateFields.skills = skills;
    if (projects) updateFields.projects = projects;
    if (certifications) updateFields.certifications = certifications;
    if (experience) updateFields.experience = experience;
    if (careerPreferences) updateFields.careerPreferences = careerPreferences;
    if (socialLinks) updateFields.socialLinks = socialLinks;

    const user = await User.findByIdAndUpdate(
        req.user._id,
        { $set: updateFields },
        { new: true, runValidators: true }
    ).select("-password -refreshToken -passwordResetToken -passwordResetExpiry");

    if (!user) {
        throw new ApiError(404, "User not found");
    }

    return res
        .status(200)
        .json(new Apiresponse(200, user, "Profile updated successfully"));
});

export {
    loginOrRegister,
    registerUser,
    loginUser,
    googleAuth,
    logoutUser,
    refreshAccessToken,
    forgotPassword,
    resetPassword,
    getCurrentUser,
    updateProfile,
};
