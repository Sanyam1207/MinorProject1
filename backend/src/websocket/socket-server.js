import { Server } from "socket.io";
import { CORS_ORIGINS } from "../config/config.js";
import { createAIQueryHandler } from "./ai-query-handler.js";
import { createInterviewSpeechController } from "./interview-speech.js";
import { getAuthenticatedUser } from "./auth-context.js";
import { rooms, setIO } from "../core/realtime.js";
import { registerModuleSockets } from "../modules/index.js";

export const attachSocketServer = (server) => {
    const io = new Server(server, {
        // CORS env: exact allow-list when configured; reflect any origin only in local/demo setups.
        cors: { origin: CORS_ORIGINS, credentials: true },
    });
    setIO(io);

    // Resolve the user once per connection, before any event handler runs, so
    // early client events (e.g. attendance:presenter:join) are never dropped.
    // Anonymous sockets are allowed; handlers decide what they may do.
    io.use(async (socket, next) => {
        try {
            socket.data.user = await getAuthenticatedUser(socket);
        } catch {
            socket.data.user = null;
        }
        next();
    });

    io.on("connection", (socket) => {
        const user = socket.data.user;
        if (user?._id) {
            socket.join(rooms.user(user._id));
            if (user.role) socket.join(rooms.role(user.role));
        }

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

        // Feature modules (notifications, attendance presenter rooms, ...).
        registerModuleSockets(io, socket, { user });
    });

    console.log("Socket.io running on /socket.io");
    return io;
};
