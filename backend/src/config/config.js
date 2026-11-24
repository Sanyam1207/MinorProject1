import dotenv from "dotenv";
dotenv.config({
    path: "./.env"
})
export const PORT = process.env.PORT
export const DB_NAME = process.env.DB_NAME
export const MONGO_URI = process.env.MONGO_URI
export const CORS = process.env.CORS
export const NODE_ENV = process.env.NODE_ENV
export const CLIENT_ID = process.env.CLIENT_ID
export const CLIENT_SECRET = process.env.CLIENT_SECRET
export const GOOGLE_GMAIL_REDIRECT_URI = process.env.GOOGLE_GMAIL_REDIRECT_URI || "http://localhost:8000/api/v1/auth/google/gmail/callback"
export const FRONTEND_URL = (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/$/, "")
export const TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY
export const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET
export const ACCESS_TOKEN_EXPIRY = process.env.ACCESS_TOKEN_EXPIRY
export const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET
export const REFRESH_TOKEN_EXPIRY = process.env.REFRESH_TOKEN_EXPIRY
export const AI_SERVICE_URL = process.env.AI_SERVICE_URL || "http://localhost:9000"
export const TPO_EMAIL = (process.env.TPO_EMAIL || "").trim().toLowerCase()
export const TPO_INITIAL_PASSWORD = process.env.TPO_INITIAL_PASSWORD || ""
export const SMTP_SERVICE = (process.env.SMTP_SERVICE || "").trim()
export const SMTP_HOST = (process.env.SMTP_HOST || "").trim()
export const SMTP_PORT = Number(process.env.SMTP_PORT) || 587
export const SMTP_SECURE = process.env.SMTP_SECURE === undefined
    ? SMTP_PORT === 465
    : String(process.env.SMTP_SECURE).toLowerCase() === "true"
export const SMTP_USER = (process.env.SMTP_USER || "").trim()
export const SMTP_PASS = process.env.SMTP_PASS || ""
export const SMTP_FROM = (process.env.SMTP_FROM || "").trim()
export const CLOUDINARY_CLOUD_NAME = (process.env.CLOUDINARY_CLOUD_NAME || "").trim()
export const CLOUDINARY_API_KEY = (process.env.CLOUDINARY_API_KEY || "").trim()
export const CLOUDINARY_API_SECRET = (process.env.CLOUDINARY_API_SECRET || "").trim()
export const CLOUDINARY_RESUME_FOLDER = (process.env.CLOUDINARY_RESUME_FOLDER || "tnp-ai/resumes").trim()
export const INTERVIEW_ASR_MODEL_DIR = (process.env.INTERVIEW_ASR_MODEL_DIR || "models/sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06").trim()
export const INTERVIEW_TTS_MODEL_DIR = (process.env.INTERVIEW_TTS_MODEL_DIR || "models/kokoro-en-v0_19").trim()
export const INTERVIEW_TTS_SPEAKER_ID = Number(process.env.INTERVIEW_TTS_SPEAKER_ID) || 6
export const INTERVIEW_SPEECH_THREADS = Math.max(1, Number(process.env.INTERVIEW_SPEECH_THREADS) || 2)
export const INTERVIEW_ANSWER_SECONDS = Math.max(10, Math.min(300, Number(process.env.INTERVIEW_ANSWER_SECONDS) || 60))
export const INTERVIEW_SILENCE_SECONDS = Math.max(2, Math.min(15, Number(process.env.INTERVIEW_SILENCE_SECONDS) || 4))
export const INTERVIEW_SPEECH_RMS_THRESHOLD = Math.max(0.001, Math.min(0.2, Number(process.env.INTERVIEW_SPEECH_RMS_THRESHOLD) || 0.012))

// ── Integration (Minor Project) ─────────────────────────────────────────────
export const APP_NAME = (process.env.APP_NAME || "Matchy Campus").trim()
// College time zone: timetables, "tomorrow 10am" parsing, working hours.
export const APP_TIMEZONE = (process.env.APP_TIMEZONE || "Asia/Kolkata").trim()
// How the Python agent service reaches this backend's tool endpoints.
export const INTERNAL_API_URL = (process.env.INTERNAL_API_URL || `http://127.0.0.1:${process.env.PORT || 8000}`).replace(/\/$/, "")
// Signs the short-lived tokens the copilot uses to call /api/v1/agent-tools.
export const AGENT_TOOL_SECRET = process.env.AGENT_TOOL_SECRET || ""
export const AGENT_TOOL_TOKEN_TTL = process.env.AGENT_TOOL_TOKEN_TTL || "15m"
// Comma-separated origins allowed by CORS/socket.io ("*" or empty = reflect any origin, dev only).
export const CORS_ORIGINS = !CORS || CORS.trim() === "*"
    ? true
    : CORS.split(",").map((origin) => origin.trim().replace(/\/$/, "")).filter(Boolean)
