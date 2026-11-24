import { Server } from "socket.io";
import { CORS } from "../config/config.js";
import { createAIQueryHandler } from "./ai-query-handler.js";
import { createInterviewSpeechController } from "./interview-speech.js";

// Reflect arbitrary origins only in local/demo configuration. A configured
// comma-separated allow-list remains exact and supports credentialed sockets.
const corsOrigin = !CORS || CORS === "*"
    ? true
    : CORS.split(",").map((origin) => origin.trim()).filter(Boolean);

export const attachSocketServer = (server) => {
    const io = new Server(server, {
        cors: { origin: corsOrigin, credentials: true },
    });

    io.on("connection", (socket) => {
        let queryHandler;
        const interviewSpeech = createInterviewSpeechController({
            socket,
            sendTranscriptToAgent: (payload) => queryHandler(payload),
        });
        queryHandler = createAIQueryHandler(io, {
            onAgentResponse: interviewSpeech.handleAgentResponse,
        }).bind(socket);

        socket.on("query", queryHandler);
        socket.on("interview:audio:start", interviewSpeech.start);
        socket.on("interview:audio:chunk", interviewSpeech.chunk);
        socket.on("interview:audio:end", interviewSpeech.end);
        socket.on("interview:audio:cancel", interviewSpeech.cancel);
        socket.on("disconnect", interviewSpeech.dispose);
    });

    console.log("Socket.io running on /socket.io");
    return io;
};
