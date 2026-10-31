import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { fileURLToPath } from 'node:url';
import { serveCanvasStatic } from './static.ts';
import { WebSocketServer } from "ws";
import { Store, sourceConnectionKey, type Source } from "./state.ts";
import { createApp } from "./app.ts";
import { AccountStore } from "./account.ts";
import { TerminalManager } from "./terminals.ts";
import { allowedOrigin, parseAllowedOrigins } from "./auth.ts";
import { authenticateWebSocket } from "./websocket-auth.ts";
import {
  closeProviderConnections,
  prepareOpenBridge,
  writeRemoteBridgeRegistry,
  installCanvasHelper,
  listResources,
  editorAuthority,
} from "./providers.ts";
import { OpenDownloadService } from "./open-download.ts";
import { AssetStore } from "./assets.ts";
import { UploadService } from "./uploads.ts";
import { vscodeDirectoryUri } from "./editor-links.ts";
import { WindowContentService } from "./window-content.ts";
import { UrlForwardService } from "./url-forward.ts";
const dataDir =
  process.env.CANVAS_DATA_DIR ?? join(homedir(), ".local/share/canvas");
const accounts = new AccountStore(dataDir);
const account = accounts.account;
const store = new Store(join(dataDir, "canvas.db"));
const urlForwards = new UrlForwardService(store);
const assets = new AssetStore(dataDir, store);
const terminals = new TerminalManager();
const uploads = new UploadService(terminals);
const helperBytes = readFileSync(new URL("../cli/canvas", import.meta.url));
const socketSessions = new WeakMap<import("ws").WebSocket, string>();
const downloads = new OpenDownloadService({
  openUrl: (source, url, session) => urlForwards.open(source, url, session),
  directoryUri: async (source, path) => vscodeDirectoryUri(await editorAuthority(source), path),
  createUpload: metadata => assets.begin(metadata),
  readTemporary: id => assets.readTemporary(id),
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
const windowContent = new WindowContentService({
  store, assets,
  content: (source, spaceId, windowId) => terminals.content(source, spaceId, windowId),
  registerStaged: (assetId, sessionId) => downloads.registerStaged(assetId, sessionId),
});
const allowedOrigins = parseAllowedOrigins(process.env.CANVAS_ALLOWED_ORIGINS);
const app = createApp(store, account, terminals, {
  updateAccount: (username, password) => accounts.update(username, password),
  allowedOrigins,
  openDownload: (ticket, session) => downloads.open(ticket, session),
  prepareDownload: (ticket, session, context) => downloads.prepare(ticket, session, context),
  closeOpenBridge: (sourceId) => { uploads.closeSource(sourceId); windowContent.closeSource(sourceId); urlForwards.closeSource(sourceId); return downloads.closeSource(sourceId); },
  assets,
  uploads,
  windowContent,
  openUrl: (source, url, session) => urlForwards.open(source, url, session),
});
app.get("/api/*", (c) => c.json({ error: "Not found" }, 404));
app.use("*", async (c, next) => {
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "same-origin");
  return next();
});
const staticDir = resolve(process.env.CANVAS_STATIC_DIR ?? fileURLToPath(new URL('../web/', import.meta.url)));
app.use('*', serveCanvasStatic(staticDir));
const requestListener = getRequestListener(app.fetch);
const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
let stopping = false;
store.on("sessions", () => {
  for (const ws of wss.clients)
    if (socketSessions.has(ws) && !store.hasSession(socketSessions.get(ws)!)) {
      ws.close(1008, "Session expired");
      ws.terminate();
    }
});
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (socketSessions.has(ws) && !store.hasSession(socketSessions.get(ws)!)) {
      ws.close(1008, "Session expired");
      ws.terminate();
      continue;
    }
    if (ws.readyState === 1) ws.ping();
  }
}, 30_000);
heartbeat.unref();
const upgrade = (request: import("node:http").IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
  if (stopping) {
    socket.write(
      "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n",
    );
    socket.destroy();
    return;
  }
  if (urlForwards.handleUpgrade(request, socket, head)) return;
  const origin = request.headers.origin;
  if (!origin || !allowedOrigin(origin, `http://${request.headers.host}`, allowedOrigins)) {
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
  wss.handleUpgrade(request, socket, head, (ws) => authenticateWebSocket(ws, token => store.hasSession(token), token => {
    const current = store.get<Source>("source", sourceId);
    if (!current || sourceConnectionKey(current) !== sourceConnectionKey(source)) {
      ws.close(1008, "Connection changed");
      return;
    }
    socketSessions.set(ws, token);
    ws.once("close", () => uploads.cancel(ws));
    ws.on("message", (bytes, binary) => {
      if (binary || Buffer.byteLength(bytes.toString()) > 128 * 1024) return;
      const session = socketSessions.get(ws) || "";
      if (!store.hasSession(session)) return;
      try {
        const message = JSON.parse(bytes.toString());
        if (message.type === "upload-begin") {
          const current = store.get<Source>("source", sourceId);
          if (current && sourceConnectionKey(current) === sourceConnectionKey(source))
            void uploads.begin(source, windowId, ws, session, { id: message.id, files: message.files });
        } else if (message.type === "upload-cancel" && typeof message.id === "string") uploads.cancel(ws, message.id);
        else if (message.type === "directory-received" && typeof message.id === "string") downloads.directoryReceived(message.id, ws, session);
        else if (message.type === "url-received" && typeof message.id === "string") downloads.urlReceived(message.id, ws, session);
      } catch { /* Only named file-transfer messages are handled here. */ }
    });
    ws.once("close", downloads.retainSource(sourceId));
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
  }));
};
const hosts = [...new Set((process.env.CANVAS_HOST ?? "127.0.0.1").split(",").map(host => host.trim()).filter(Boolean))];
if (!hosts.length) throw new Error("CANVAS_HOST requires a listening address");
const port = Number(process.env.CANVAS_PORT ?? 3010);
const servers = hosts.map(host => {
  const server = createServer((request, response) => {
    // Public path proxies expose the API, never another site's executable UI.
    if (request.headers['x-forwarded-prefix'] && !request.url?.startsWith('/api/')) {
      response.writeHead(404).end('Not found'); return;
    }
    if (!urlForwards.handle(request, response)) void requestListener(request, response);
  });
  server.on("upgrade", upgrade);
  server.listen(port, host, () => console.log(`Canvas listening on http://${host.includes(":") ? `[${host}]` : host}:${port}`));
  return server;
});
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(heartbeat);
  windowContent.close();
  await urlForwards.close();
  await uploads.closeAll();
  await terminals.closeAll();
  await downloads.closeAll();
  await assets.close();
  await closeProviderConnections();
  store.emit("close");
  wss.close();
  setTimeout(() => process.exit(0), 3000).unref();
  await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  store.close();
  process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
