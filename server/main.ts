import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { WebSocketServer } from "ws";
import { Store, type Source } from "./state.ts";
import { createApp, type Account } from "./app.ts";
import { TerminalManager } from "./terminals.ts";
import { sessionCookie } from "./auth.ts";
import {
  closeStatusObservers,
  closeProviderConnections,
  prepareOpenBridge,
  writeRemoteBridgeRegistry,
  installCanvasHelper,
  listResources,
} from "./providers.ts";
import { OpenDownloadService } from "./open-download.ts";
const dataDir =
  process.env.CANVAS_DATA_DIR ?? join(homedir(), ".local/share/canvas");
const accountFile = join(dataDir, "auth.json");
if (!existsSync(accountFile))
  throw new Error(
    "Run npm run setup to create the single Canvas account first.",
  );
const account: Account = JSON.parse(readFileSync(accountFile, "utf8"));
const store = new Store(join(dataDir, "canvas.db"));
const terminals = new TerminalManager();
const helperBytes = readFileSync(new URL("../cli/canvas", import.meta.url));
const socketSessions = new WeakMap<import("ws").WebSocket, string>();
const downloads = new OpenDownloadService({
  prepare: prepareOpenBridge,
  publishRemote: writeRemoteBridgeRegistry,
  installHelper: (source) => installCanvasHelper(source, helperBytes),
  resources: listResources,
  recipient: async (sourceId, windowId) => {
    const recipient = await terminals.downloadRecipient(sourceId, windowId);
    const socket = recipient?.socket;
    const sessionId = socket && socketSessions.get(socket);
    return socket && sessionId ? { socket, sessionId, isCurrent: recipient!.isCurrent } : undefined;
  },
});
const app = createApp(store, account, terminals, {
  secureCookie: process.env.CANVAS_SECURE_COOKIE === "1",
  openDownload: (ticket, session) => downloads.open(ticket, session),
  closeOpenBridge: (sourceId) => downloads.closeSource(sourceId),
});
app.get("/api/*", (c) => c.json({ error: "Not found" }, 404));
app.use("*", async (c, next) => {
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "same-origin");
  return next();
});
const staticDir = resolve(process.env.CANVAS_STATIC_DIR ?? "dist/web");
app.use("*", serveStatic({ root: staticDir }));
app.get("*", serveStatic({ path: join(staticDir, "index.html") }));
const server = createServer(getRequestListener(app.fetch));
const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
let stopping = false;
store.on("sessions", () => {
  for (const ws of wss.clients)
    if (!store.hasSession(socketSessions.get(ws) ?? "")) {
      ws.close(1008, "Session expired");
      ws.terminate();
    }
});
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!store.hasSession(socketSessions.get(ws) ?? "")) {
      ws.close(1008, "Session expired");
      ws.terminate();
      continue;
    }
    if (ws.readyState === 1) ws.ping();
  }
}, 30_000);
heartbeat.unref();
server.on("upgrade", (request, socket, head) => {
  if (stopping) {
    socket.write(
      "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n",
    );
    socket.destroy();
    return;
  }
  const origin = request.headers.origin;
  let sameOrigin = false;
  try {
    sameOrigin = !!origin && new URL(origin).host === request.headers.host;
  } catch {}
  if (!sameOrigin || !store.hasSession(sessionCookie(request.headers.cookie))) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  let url: URL;
  try {
    url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  } catch {
    socket.destroy();
    return;
  }
  if (url.pathname !== "/api/terminal") {
    socket.destroy();
    return;
  }
  const sourceId = url.searchParams.get("sourceId") ?? "",
    spaceId = url.searchParams.get("spaceId") ?? "",
    windowId = url.searchParams.get("windowId") ?? "";
  const source = store.get<Source>("source", sourceId);
  if (!source || !spaceId || !windowId) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    socketSessions.set(ws, sessionCookie(request.headers.cookie));
    ws.on("error", () => ws.close());
    ws.send(JSON.stringify({ type: "status", status: "connecting" }));
    void terminals.connect(source, { sourceId, spaceId, windowId }, ws)
      .then(() => downloads.ensureSource(source).catch(() => {}))
      .catch((error) => {
        if (ws.readyState === 1) {
          ws.send(
            JSON.stringify({
              type: "status",
              status: "error",
              error: error.message,
            }),
          );
          ws.close(1011, "Connection failed");
        }
      });
  });
});
const host = process.env.CANVAS_HOST ?? "127.0.0.1",
  port = Number(process.env.CANVAS_PORT ?? 3010);
server.listen(port, host, () =>
  console.log(`Canvas listening on http://${host}:${port}`),
);
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(heartbeat);
  closeStatusObservers();
  await terminals.closeAll();
  await downloads.closeAll();
  await closeProviderConnections();
  store.emit("close");
  wss.close();
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
