#!/usr/bin/env node
// Start the whole stack for local development with one command:
//   npm run dev            (from the repository root)
//
// Runs the Python agent service (:9000), the Node backend (:8000) and the
// Vite frontend (:5173) side by side with prefixed, coloured logs. Ctrl+C
// stops all three. No extra dependencies required.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const python = path.join(root, "ai-service", ".venv", "bin", "python");

const services = [
  {
    name: "ai",
    color: 35,
    cwd: path.join(root, "ai-service"),
    command: existsSync(python) ? python : "python3",
    args: ["-m", "app.main"],
    hint: 'cd ai-service && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt',
  },
  { name: "api", color: 36, cwd: path.join(root, "backend"), command: "npm", args: ["run", "dev"], hint: "cd backend && npm install" },
  { name: "web", color: 32, cwd: path.join(root, "frontend"), command: "npm", args: ["run", "dev"], hint: "cd frontend && npm install" },
];

const checkPort = (port, host = "127.0.0.1") => new Promise((resolve) => {
  const socket = net.connect({ port, host });
  socket.once("connect", () => { socket.end(); resolve(true); });
  socket.once("error", () => resolve(false));
});

const prefix = (service, line) => `\x1b[${service.color}m[${service.name}]\x1b[0m ${line}`;

const main = async () => {
  for (const dir of ["backend", "frontend"]) {
    if (!existsSync(path.join(root, dir, "node_modules"))) {
      console.error(`Missing ${dir}/node_modules — run: cd ${dir} && npm install`);
      process.exit(1);
    }
  }
  for (const dir of ["backend", "frontend", "ai-service"]) {
    if (!existsSync(path.join(root, dir, ".env"))) {
      console.warn(`Warning: ${dir}/.env not found — copy ${dir}/.env.example to ${dir}/.env and fill it in.`);
    }
  }
  if (!(await checkPort(27017))) {
    console.warn("Warning: MongoDB is not reachable on 127.0.0.1:27017 (start it with `brew services start mongodb-community` or set MONGO_URI).");
  }

  const children = services.map((service) => {
    const child = spawn(service.command, service.args, {
      cwd: service.cwd,
      env: { ...process.env, FORCE_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [child.stdout, child.stderr]) {
      let buffer = "";
      stream.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        for (const line of lines) if (line.trim()) console.log(prefix(service, line));
      });
    }
    child.on("error", (error) => console.error(prefix(service, `failed to start: ${error.message}. Try: ${service.hint}`)));
    child.on("exit", (code, signal) => console.log(prefix(service, `exited (${signal || code})`)));
    return child;
  });

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log("Starting: agents → http://127.0.0.1:9000 · api → http://localhost:8000 · web → http://localhost:5173  (Ctrl+C to stop)");
};

main();
