import crypto from "crypto";
import { TOKEN_ENCRYPTION_KEY } from "../config/config.js";

const ALGORITHM = "aes-256-gcm";

const getKey = () => {
    if (!TOKEN_ENCRYPTION_KEY || TOKEN_ENCRYPTION_KEY.length !== 64) {
        throw new Error("TOKEN_ENCRYPTION_KEY must be set to a 32-byte hex string (64 hex chars)");
    }
    return Buffer.from(TOKEN_ENCRYPTION_KEY, "hex");
};

export const encrypt = (plaintext) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
    const encrypted = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [iv.toString("hex"), authTag.toString("hex"), encrypted.toString("hex")].join(":");
};

export const decrypt = (payload) => {
    const [ivHex, authTagHex, dataHex] = String(payload).split(":");
    if (!ivHex || !authTagHex || !dataHex) {
        throw new Error("Malformed encrypted payload");
    }
    const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]);
    return decrypted.toString("utf8");
};
