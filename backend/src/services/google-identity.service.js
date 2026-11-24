// Google Identity Services ID-token verification (docs/contracts/AUTH-FACULTY.md §4.3).
//
// `googleIdentity` is a mutable test seam: tests replace `isConfigured` /
// `verifyIdToken` and restore them afterwards. Only a verified ID token is
// ever trusted — there is no fallback to client-supplied email/name/googleId.
import { OAuth2Client } from "google-auth-library";
import { CLIENT_ID } from "../config/config.js";

let client = null;
const getClient = () => {
    client ||= new OAuth2Client(CLIENT_ID);
    return client;
};

export const googleIdentity = {
    isConfigured: () => Boolean(CLIENT_ID),
    /** Verifies signature, audience (CLIENT_ID), issuer and expiry; returns the payload. Throws when invalid. */
    verifyIdToken: async (idToken) =>
        (await getClient().verifyIdToken({ idToken, audience: CLIENT_ID })).getPayload(),
};
