/**
 * Fake frontend - sends one query, prints every response chunk as it streams in.
 *
 *   node scripts/ui_test_client.mjs ["the question"]
 *
 * socket.io-client is already a devDependency of this repo.
 */
import { io } from "socket.io-client";

const SERVER = "http://localhost:8000";
const user_query = process.argv[2] || "build my resume";
const requestId = crypto.randomUUID();

const socket = io(SERVER, { transports: ["websocket"] });

socket.on("connect", () => {
  console.log(`[ui] connected, sending query requestId=${requestId}`);
  socket.emit("query", { requestId, user_query });
});
socket.on("connect_error", (e) => console.log("[ui] connect error:", e.message));

socket.on("response", (payload) => {
  console.log(`[ui] <- isEnd=${payload.isEnd} header="${payload.header_message}" response(${payload.response.length} chars)`);
  if (payload.isEnd) {
    console.log("\n--- final response ---\n" + payload.response);
    socket.disconnect();
    process.exit(0);
  }
});
