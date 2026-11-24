import { OAuth2Client } from "google-auth-library";
import { CLIENT_ID, CLIENT_SECRET, GOOGLE_GMAIL_REDIRECT_URI } from "../config/config.js";

export const createOAuth2Client = () =>
    new OAuth2Client(CLIENT_ID, CLIENT_SECRET, GOOGLE_GMAIL_REDIRECT_URI);

export const GMAIL_SEND_SCOPES = [
    "https://www.googleapis.com/auth/gmail.send",
    "openid",
    "email",
];
