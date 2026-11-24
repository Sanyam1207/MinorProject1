import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import {
    INTERVIEW_ANSWER_SECONDS,
    INTERVIEW_ASR_MODEL_DIR,
    INTERVIEW_SPEECH_THREADS,
    INTERVIEW_SILENCE_SECONDS,
    INTERVIEW_SPEECH_RMS_THRESHOLD,
    INTERVIEW_TTS_MODEL_DIR,
    INTERVIEW_TTS_SPEAKER_ID,
} from "../config/config.js";
import { getAuthenticatedUser, getEffectiveRole } from "./auth-context.js";

const require = createRequire(import.meta.url);
const sherpaOnnx = require("sherpa-onnx-node");

const resolveModelPath = (directory, filename) => path.join(path.resolve(process.cwd(), directory), filename);

let recognizer;
let ttsPromise;

const assertFiles = (label, files) => {
    const missing = files.filter((filename) => !fs.existsSync(filename));
    if (missing.length) {
        throw new Error(`${label} model is not installed. Run \"npm run setup:interview-speech\" in the Node backend. Missing: ${missing.join(", ")}`);
    }
};

const getRecognizer = () => {
    if (recognizer) return recognizer;
    const encoder = resolveModelPath(INTERVIEW_ASR_MODEL_DIR, "encoder.onnx");
    const decoder = resolveModelPath(INTERVIEW_ASR_MODEL_DIR, "decoder.onnx");
    const joiner = resolveModelPath(INTERVIEW_ASR_MODEL_DIR, "joiner.onnx");
    const tokens = resolveModelPath(INTERVIEW_ASR_MODEL_DIR, "tokens.txt");
    assertFiles("Interview speech recognition", [encoder, decoder, joiner, tokens]);

    recognizer = new sherpaOnnx.OnlineRecognizer({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
            transducer: { encoder, decoder, joiner },
            tokens,
            numThreads: INTERVIEW_SPEECH_THREADS,
            provider: "cpu",
            modelType: "zipformer2",
            debug: false,
        },
        decodingMethod: "greedy_search",
        enableEndpoint: true,
        rule1MinTrailingSilence: 2.4,
        rule2MinTrailingSilence: 1.2,
        rule3MinUtteranceLength: 20,
    });
    return recognizer;
};

const getTts = async () => {
    if (!ttsPromise) {
        const model = resolveModelPath(INTERVIEW_TTS_MODEL_DIR, "model.onnx");
        const voices = resolveModelPath(INTERVIEW_TTS_MODEL_DIR, "voices.bin");
        const tokens = resolveModelPath(INTERVIEW_TTS_MODEL_DIR, "tokens.txt");
        const dataDir = resolveModelPath(INTERVIEW_TTS_MODEL_DIR, "espeak-ng-data");
        assertFiles("Interview text to speech", [model, voices, tokens, dataDir]);
        ttsPromise = sherpaOnnx.OfflineTts.createAsync({
            model: {
                kokoro: { model, voices, tokens, dataDir },
                numThreads: INTERVIEW_SPEECH_THREADS,
                provider: "cpu",
                debug: false,
            },
            maxNumSentences: 2,
        }).catch((error) => {
            ttsPromise = undefined;
            throw error;
        });
    }
    return ttsPromise;
};

const pcm16ToFloat32 = (chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const sampleCount = Math.floor(buffer.byteLength / 2);
    const samples = new Float32Array(sampleCount);
    for (let index = 0; index < sampleCount; index += 1) {
        samples[index] = buffer.readInt16LE(index * 2) / 32768;
    }
    return samples;
};

const float32ToWav = (samples, sampleRate) => {
    const wav = Buffer.allocUnsafe(44 + samples.length * 2);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(36 + samples.length * 2, 4);
    wav.write("WAVE", 8);
    wav.write("fmt ", 12);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(sampleRate, 24);
    wav.writeUInt32LE(sampleRate * 2, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(samples.length * 2, 40);
    for (let index = 0; index < samples.length; index += 1) {
        const value = Math.max(-1, Math.min(1, samples[index]));
        wav.writeInt16LE(Math.round(value < 0 ? value * 32768 : value * 32767), 44 + index * 2);
    }
    return wav;
};

const normalizeTranscript = (value) => String(value || "").replace(/\s+/g, " ").trim();
const combinedTranscript = (state, partial = "") => normalizeTranscript([...state.segments, partial].filter(Boolean).join(" "));
const rootMeanSquare = (samples) => {
    if (!samples.length) return 0;
    let sum = 0;
    for (let index = 0; index < samples.length; index += 1) sum += samples[index] * samples[index];
    return Math.sqrt(sum / samples.length);
};

const shouldSpeak = (modeName, payload) => {
    if (modeName !== "ai-interviewer" || !payload?.response) return false;
    return payload.header_message === "text:mode:interview" || payload.header_message === "interview:end";
};

export const createInterviewSpeechController = ({ socket, sendTranscriptToAgent }) => {
    const sessions = new Map();

    const emitError = (requestId, message, code = "INTERVIEW_SPEECH_ERROR") => {
        socket.emit("interview:audio:error", { requestId, code, message });
    };

    const clearSession = (requestId) => {
        const state = sessions.get(requestId);
        if (!state) return null;
        clearTimeout(state.deadline);
        clearTimeout(state.silenceDeadline);
        sessions.delete(requestId);
        return state;
    };

    const decode = (state) => {
        while (state.recognizer.isReady(state.stream)) state.recognizer.decode(state.stream);
        const partial = normalizeTranscript(state.recognizer.getResult(state.stream)?.text);
        if (state.recognizer.isEndpoint(state.stream)) {
            if (partial) state.segments.push(partial);
            state.recognizer.reset(state.stream);
            return "";
        }
        return partial;
    };

    const finalize = async (requestId) => {
        const state = clearSession(requestId);
        if (!state || state.finalizing) return;
        state.finalizing = true;
        try {
            state.stream.acceptWaveform({ samples: new Float32Array(Math.round(state.sampleRate * 0.4)), sampleRate: state.sampleRate });
            state.stream.inputFinished();
            const partial = decode(state);
            const transcript = combinedTranscript(state, partial);
            if (!transcript) {
                emitError(requestId, "No speech was recognized. Please retry this answer.", "EMPTY_TRANSCRIPT");
                return;
            }

            const durationSeconds = Math.min(INTERVIEW_ANSWER_SECONDS, (Date.now() - state.startedAt) / 1000);
            socket.emit("interview:transcript", {
                requestId,
                sessionId: state.payload.sessionId,
                text: transcript,
                partial: false,
                isFinal: true,
            });
            await sendTranscriptToAgent({
                ...state.payload,
                requestId,
                user_query: transcript,
                mode_name: "ai-interviewer",
                source: "interview-voice-stream",
                feature: "mock-interview",
                details: {
                    ...(state.payload.details || {}),
                    input_type: "voice",
                    speech_duration_seconds: durationSeconds,
                    speech_language: state.payload.language || "en-IN",
                },
            });
        } catch (error) {
            console.error("Unable to finalize interview audio:", error);
            emitError(requestId, error.message);
        }
    };

    const start = async (payload = {}, acknowledgement) => {
        const requestId = String(payload.requestId || "");
        try {
            if (!requestId || !payload.sessionId) throw new Error("Interview audio requires requestId and sessionId.");
            if (sessions.size > 0) throw new Error("Another interview answer is already recording.");
            const user = await getAuthenticatedUser(socket);
            const effectiveRole = getEffectiveRole(user, payload.user_role);
            if (!user || effectiveRole !== "student") throw new Error("An authenticated student session is required.");
            if (payload.mode_name !== "ai-interviewer") throw new Error("Audio streaming is available only for the interview agent.");

            const sampleRate = Math.round(Number(payload.sampleRate));
            if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 96000) throw new Error("Unsupported microphone sample rate.");
            const activeRecognizer = getRecognizer();
            const state = {
                payload,
                sampleRate,
                recognizer: activeRecognizer,
                stream: activeRecognizer.createStream(),
                segments: [],
                startedAt: Date.now(),
                finalizing: false,
                deadline: setTimeout(() => finalize(requestId), INTERVIEW_ANSWER_SECONDS * 1000),
                silenceDeadline: null,
            };
            sessions.set(requestId, state);
            acknowledgement?.({ ok: true, answerSeconds: INTERVIEW_ANSWER_SECONDS });
        } catch (error) {
            emitError(requestId, error.message, "INTERVIEW_AUDIO_START_FAILED");
            acknowledgement?.({ ok: false, message: error.message });
        }
    };

    const chunk = ({ requestId, audio } = {}) => {
        const state = sessions.get(String(requestId || ""));
        if (!state || state.finalizing || !audio) return;
        const bytes = Buffer.isBuffer(audio) ? audio.byteLength : audio.byteLength || 0;
        if (!bytes || bytes > 256 * 1024) {
            emitError(requestId, "Invalid interview audio chunk.", "INVALID_AUDIO_CHUNK");
            return;
        }
        try {
            const samples = pcm16ToFloat32(audio);
            state.stream.acceptWaveform({ samples, sampleRate: state.sampleRate });
            const partial = decode(state);
            const text = combinedTranscript(state, partial);
            if (rootMeanSquare(samples) >= INTERVIEW_SPEECH_RMS_THRESHOLD) {
                clearTimeout(state.silenceDeadline);
                state.silenceDeadline = setTimeout(() => finalize(requestId), INTERVIEW_SILENCE_SECONDS * 1000);
            }
            if (text && text !== state.lastTranscript) {
                state.lastTranscript = text;
                socket.emit("interview:transcript", {
                    requestId,
                    sessionId: state.payload.sessionId,
                    text,
                    partial: true,
                    isFinal: false,
                });
            }
        } catch (error) {
            clearSession(requestId);
            emitError(requestId, error.message, "TRANSCRIPTION_FAILED");
        }
    };

    const end = ({ requestId } = {}) => finalize(String(requestId || ""));
    const cancel = ({ requestId } = {}) => clearSession(String(requestId || ""));
    const dispose = () => [...sessions.keys()].forEach(clearSession);

    const handleAgentResponse = async ({ modeName, payload, requestId }) => {
        if (!shouldSpeak(modeName, payload)) return;
        try {
            const tts = await getTts();
            const audio = await tts.generateAsync({
                text: payload.response,
                enableExternalBuffer: true,
                generationConfig: new sherpaOnnx.GenerationConfig({
                    sid: INTERVIEW_TTS_SPEAKER_ID,
                    speed: 0.96,
                    silenceScale: 0.2,
                }),
            });
            socket.emit("interview:audio:response", {
                requestId,
                header_message: payload.header_message,
                data: payload.data,
                mimeType: "audio/wav",
                audio: float32ToWav(audio.samples, audio.sampleRate),
            });
        } catch (error) {
            console.error("Interview TTS failed:", error);
            emitError(requestId, error.message, "TTS_FAILED");
        }
    };

    return { start, chunk, end, cancel, dispose, handleAgentResponse };
};
