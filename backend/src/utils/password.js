// Password helpers (docs/contracts/AUTH-FACULTY.md §0, §4.2, §7.2).
import crypto from "node:crypto";
import { fail } from "../core/http.js";

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

// No look-alike characters (0/O, 1/l/I), so a password read off a screen can be typed.
const TEMP_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

const randomGroup = (length) => Array.from(
    { length },
    () => TEMP_ALPHABET[crypto.randomInt(TEMP_ALPHABET.length)],
).join("");

/**
 * A one-time temporary password for invites and admin resets, e.g. "k7Qm-Xp2r-Tz9w"
 * (14 characters, ~70 bits of entropy). Never log or persist it in plain text.
 */
export const generateTemporaryPassword = () => [randomGroup(4), randomGroup(4), randomGroup(4)].join("-");

/** Throws 400 WEAK_PASSWORD unless `pw` is a string of 8–128 characters; returns it. */
export const validateNewPassword = (pw, field = "password") => {
    if (typeof pw !== "string" || pw.length < PASSWORD_MIN_LENGTH || pw.length > PASSWORD_MAX_LENGTH) {
        throw fail(
            400,
            `Password must be ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters long.`,
            "WEAK_PASSWORD",
            { field },
        );
    }
    return pw;
};
