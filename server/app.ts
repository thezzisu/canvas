import { Hono } from "hono";
import { Readable } from "node:stream";
import { bodyLimit } from "hono/body-limit";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { verifyPassword, bearerToken, allowedOrigin } from "./auth.ts";
import { MediaTickets, mediaPath } from "./media.ts";
import { receiveCanvasFile } from "./canvas-files.ts";
import { settingsPatchSchema } from "./settings.ts";
import {
  Store,
  sourceSchema,
  sourceConnectionKey,
  canvasSchema,
  itemSchema,
  nodeLayoutSchema,
  noteNodeSchema,
  noteColorSchema,
  isTerminalNode,
  type Source,
  type Canvas,
} from "./state.ts";
import * as providers from "./providers.ts";
import type { TerminalManager } from "./terminals.ts";
import type { DownloadContext } from "./open-download.ts";
import type { AssetStore } from "./assets.ts";
import type { UploadService } from "./uploads.ts";
import type { WindowContentService } from "./window-content.ts";
import {
  BackgroundError,
  DEFAULT_BACKGROUND_OPACITY,
  backgroundContentType,
  validateBackground,
  readBackground,
  storedBackgroundContentType,
} from "./backgrounds.ts";
const nameSchema = z
  .object({ name: z.string().trim().min(1).max(100) })
  .strict();
const createWindowSchema = z.object({ name: z.string().trim().max(100).optional() }).strict();
const createSpaceSchema = createWindowSchema.extend({ sourceSpaceId: z.string().min(1).max(100).optional() });
const opacitySchema = z.number().finite().min(0).max(1);
const backgroundOpacitySchema = z.object({ opacity: opacitySchema }).strict();
const nodeListSchema = z
  .object({ nodes: z.array(itemSchema).max(500) })
  .strict();
const layoutSchema = z
  .object({
    nodes: z
      .array(
        nodeLayoutSchema
          .pick({ id: true, x: true, y: true, width: true, height: true })
          .partial()
          .required({ id: true }),
      )
      .max(500),
  })
  .strict();
const noteCreateSchema = noteNodeSchema.omit({ id: true, type: true }).extend({
  x: nodeLayoutSchema.shape.x.default(80),
  y: nodeLayoutSchema.shape.y.default(80),
  width: nodeLayoutSchema.shape.width.default(320),
  height: nodeLayoutSchema.shape.height.default(240),
});
const notePatchSchema = z.object({
  title: z.string().max(200).optional(),
  content: z.string().max(200_000).optional(),
  color: noteColorSchema.optional(),
  minimized: z.boolean().optional(),
}).strict();
const isBackgroundUpload = (method: string, path: string) =>
  method === "PUT" && /^\/api\/canvases\/[^/]+\/background$/.test(path);
const isInboxUpload = (method: string, path: string) =>
  method === "PUT" && /^\/api\/uploads\/[A-Za-z0-9_-]+$/.test(path);
const isCanvasFileUpload = (method: string, path: string) =>
  method === 'POST' && /^\/api\/canvases\/[^/]+\/files$/.test(path);
export type Account = { username: string; passwordHash: string };
export interface DownloadResponse {
  body: Readable;
  headers: Record<string, string>;
  previewHeaders?: Record<string, string>;
}
export function createApp(
  store: Store,
  account: Account,
  terminals: TerminalManager,
  options: {
    allowedOrigins?: ReadonlySet<string>;
    openDownload?: (ticket: string, sessionId: string) => Promise<DownloadResponse | undefined>;
    prepareDownload?: (ticket: string, sessionId: string, context?: DownloadContext) => boolean;
    closeOpenBridge?: (sourceId: string) => Promise<void>;
    assets?: AssetStore;
    uploads?: UploadService;
    windowContent?: WindowContentService;
    openUrl?: (source: Source, url: string, sessionId: string) => { url: string; forwarded: boolean };
  } = {},
) {
  const app = new Hono();
  const origins = options.allowedOrigins || new Set<string>();
  const media = new MediaTickets(token => store.hasSession(token), async (path, session, download) => {
    const response = await app.request(`http://canvas.internal${path}${download ? '?download=1' : '?preview=1'}`, {
      headers: { Authorization: `Bearer ${session}` },
    });
    if (!response.ok || !response.body) { await response.body?.cancel(); return; }
    return { body: Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
      headers: Object.fromEntries(response.headers) };
  }, origins);
  let attempts: { count: number; until: number } | undefined;
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    const origin = c.req.header('origin');
    if (origin && !allowedOrigin(origin, new URL(c.req.url).origin, origins))
      return c.json({ error: 'Request origin rejected' }, 403);
    if (origin) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Vary', 'Origin');
      c.header('Access-Control-Expose-Headers', 'Content-Length, Content-Disposition, Content-Range, Accept-Ranges');
    }
    if (c.req.method === 'OPTIONS') {
      c.header('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
      c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range');
      c.header('Access-Control-Max-Age', '600');
      return c.body(null, 204);
    }
    const ticketRequest = ['GET', 'HEAD'].includes(c.req.method) && /^\/api\/media\/[A-Za-z0-9_-]+$/.test(c.req.path);
    if (!['/api/login', '/api/session'].includes(c.req.path) && !ticketRequest && !store.hasSession(bearerToken(c.req.header('authorization'))))
      return c.json({ error: 'Please sign in' }, 401);
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      if (isBackgroundUpload(c.req.method, c.req.path))
        backgroundContentType(c.req.header("content-type"));
      else if (isInboxUpload(c.req.method, c.req.path) || isCanvasFileUpload(c.req.method, c.req.path)) {
        if (c.req.header("content-type") !== "application/octet-stream") return c.json({ error: "File bytes required" }, 415);
      }
      else if (!c.req.header("content-type")?.startsWith("application/json"))
        return c.json({ error: "JSON required" }, 415);
    }
    return next();
  });
  const jsonBodyLimit = bodyLimit({
    maxSize: 1024 * 1024,
    onError: (c) => c.json({ error: "Request too large" }, 413),
  });
  app.use("/api/*", (c, next) =>
    isBackgroundUpload(c.req.method, c.req.path) || isInboxUpload(c.req.method, c.req.path) || isCanvasFileUpload(c.req.method, c.req.path)
      ? next()
      : jsonBodyLimit(c, next),
  );
  app.get("/api/session", (c) =>
    c.json({
      authenticated: store.hasSession(bearerToken(c.req.header("authorization"))),
      username: account.username,
    }),
  );
  app.post('/api/media-tickets', async c => {
    const input = z.object({ path: z.string().regex(mediaPath), download: z.boolean().optional() }).strict().parse(await c.req.json());
    const ticket = await media.create(input.path, bearerToken(c.req.header('authorization')), input.download);
    return ticket ? c.json(ticket) : c.json({ error: 'Media not found' }, 404);
  });
  app.on(['GET', 'HEAD'], '/api/media/:ticket', async c => {
    const response = await media.open(c.req.param('ticket'), c.req.method, c.req.header('range'));
    return response || c.json({ error: 'Media link expired' }, 404);
  });
  app.put("/api/uploads/:token", async c => {
    const status = await options.uploads?.receive(c.req.param("token"), bearerToken(c.req.header("authorization")), c.req.raw) ?? 404;
    return status === 204 ? c.body(null, 204) : c.json({ error: status === 404 ? "Upload expired" : "Upload failed" }, status);
  });
  app.post('/api/canvases/:id/files', async c => {
    const id = c.req.param('id');
    if (id === 'overview') return c.json({ error: 'Overview is read-only' }, 403);
    if (!store.get('canvas', id) || !options.assets) return c.json({ error: 'Canvas not found' }, 404);
    const input = z.object({ filename: z.string().min(1).max(255), size: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      x: z.coerce.number().finite().min(-1e7).max(1e7), y: z.coerce.number().finite().min(-1e7).max(1e7) }).strict().parse(c.req.query());
    return c.json(await receiveCanvasFile(store, options.assets, id, input, c.req.raw, bearerToken(c.req.header('authorization'))), 201);
  });
  app.get("/api/downloads/:ticket", async (c) => {
    if (c.req.method !== "GET") return c.body(null, 405);
    const download = await options.openDownload?.(
      c.req.param("ticket"),
      bearerToken(c.req.header("authorization")),
    );
    if (!download) return c.json({ error: "Download expired" }, 404);
    const headers = c.req.query("preview") === "1" && c.req.query("download") !== "1"
      ? download.previewHeaders ?? download.headers : download.headers;
    return c.newResponse(Readable.toWeb(download.body) as ReadableStream, 200, headers);
  });
  app.post("/api/downloads/:ticket", async (c) => {
    const context = z.object({
      canvasId: z.union([z.string().uuid(), z.literal("overview")]).optional(), anchorId: z.string().max(150).optional(),
    }).strict().parse(await c.req.json());
    const prepared = options.prepareDownload?.(c.req.param("ticket"), bearerToken(c.req.header("authorization")), context);
    return prepared ? c.body(null, 204) : c.json({ error: "Download expired" }, 404);
  });
  app.post("/api/sources/:id/spaces/:space/windows/:window/scan", async c => {
    z.object({}).strict().parse(await c.req.json());
    const source = store.get<Source>("source", c.req.param("id"));
    if (!source || !options.windowContent) return c.json({ error: "Window not found" }, 404);
    return c.json(await options.windowContent.scan(source, c.req.param("space"), c.req.param("window"), bearerToken(c.req.header("authorization")), c.req.raw.signal));
  });
  app.post("/api/content-scans/:scan/items/:item/open", async c => {
    const context = z.object({
      canvasId: z.union([z.string().uuid(), z.literal("overview")]).optional(), anchorId: z.string().max(150).optional(),
      position: nodeLayoutSchema.pick({ x: true, y: true }).optional(),
    }).strict().refine(value => !value.position || !!value.canvasId && value.canvasId !== 'overview' && !value.anchorId)
      .parse(await c.req.json());
    const opened = await options.windowContent?.open(c.req.param("scan"), c.req.param("item"),
      bearerToken(c.req.header("authorization")), context, c.req.raw.signal);
    return opened ? c.json(opened) : c.json({ error: "Scan expired; scan this window again" }, 404);
  });
  app.on(["GET", "HEAD"], "/api/files/:id", async (c) => {
    const file = await options.assets?.read(c.req.param("id"));
    if (!file) return c.json({ error: "File not found" }, 404);
    const { asset, body } = file;
    const mode = c.req.query("download") === "1" || asset.preview === "file" ? "attachment" : "inline";
    const fallback = asset.filename.replace(/[^\x20-\x7e]|["\\]/gu, "_");
    const encoded = encodeURIComponent(asset.filename).replace(/[!'()*]/gu, char =>
      `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    const headers = {
      "Content-Type": asset.mime,
      "Content-Length": String(asset.size),
      "Content-Disposition": `${mode}; filename="${fallback}"; filename*=UTF-8''${encoded}`,
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
      // Sandboxing disables Chromium's native PDF viewer and triggers a download.
      // PDFs run in the browser's isolated viewer; all other previews stay sandboxed.
      "Content-Security-Policy": asset.preview === "pdf"
        ? "default-src 'none'; frame-ancestors 'self'"
        : "default-src 'none'; sandbox; frame-ancestors 'self'",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "private, no-store",
    };
    if (c.req.method === "HEAD") { body.destroy(); return c.newResponse(null, 200, headers); }
    return c.newResponse(Readable.toWeb(body) as ReadableStream, 200, headers);
  });
  app.post("/api/login", async (c) => {
    const input = z
      .object({ username: z.string().max(200), password: z.string().max(1024) })
      .parse(await c.req.json());
    const now = Date.now(), prior = attempts;
    if (prior && prior.until > now && prior.count >= 10)
      return c.json(
        { error: "Too many attempts. Try again in a minute." },
        429,
      );
    if (
      input.username !== account.username ||
      !verifyPassword(input.password, account.passwordHash)
    ) {
      attempts = {
        count: prior && prior.until > now ? prior.count + 1 : 1,
        until: prior && prior.until > now ? prior.until : now + 60_000,
      };
      return c.json({ error: "Incorrect username or password" }, 401);
    }
    attempts = undefined;
    const old = bearerToken(c.req.header("authorization"));
    if (old) store.removeSession(old);
    const token = randomBytes(32).toString("base64url");
    store.addSession(token);
    return c.json({ authenticated: true, username: account.username, token, expiresAt: Date.now() + 7 * 86400_000 });
  });
  app.post("/api/logout", async (c) => {
    store.removeSession(bearerToken(c.req.header("authorization")));
    return c.json({ ok: true });
  });
  const source = (id: string) => {
    const result = store.get<Source>("source", id);
    if (!result) throw new Error("Source not found");
    return result;
  };
  app.get("/api/state", (c) => c.json(store.snapshot()));
  app.post('/api/urls', async c => {
    const value = z.object({ sourceId: z.string().uuid(), url: z.string().max(8192) }).strict().parse(await c.req.json());
    const opened = options.openUrl?.(source(value.sourceId), value.url, bearerToken(c.req.header('authorization')));
    return opened ? c.json(opened) : c.json({ error: 'Web forwarding is unavailable' }, 503);
  });
  app.get("/api/settings", c => c.json(store.settings()));
  app.patch("/api/settings", async c => c.json(store.updateSettings(settingsPatchSchema.parse(await c.req.json()))));
  app.get("/api/events", (c) => {
    const session = bearerToken(c.req.header("authorization"));
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let pending: string | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    const flush = () => {
      if (!closed && pending && (controller.desiredSize ?? 0) > 0) {
        controller.enqueue(encoder.encode(pending));
        pending = undefined;
      }
    };
    const close = (unauthorized = false) => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      store.off("change", publish);
      store.off("sessions", checkSession);
      store.off("close", stopped);
      c.req.raw.signal.removeEventListener("abort", aborted);
      try {
        if (unauthorized)
          controller.enqueue(
            encoder.encode("event: unauthorized\ndata: {}\n\n"),
          );
        controller.close();
      } catch {
        /* A disconnected reader is already closed. */
      }
    };
    const checkSession = () => {
      if (!store.hasSession(session)) {
        close(true);
        return false;
      }
      return true;
    };
    const publish = () => {
      if (closed || !checkSession()) return;
      const snapshot = store.snapshot();
      // Keep only the latest snapshot when a browser is temporarily slow.
      pending = `event: state\nid: ${snapshot.instanceId}:${snapshot.revision}\ndata: ${JSON.stringify(snapshot)}\n\n`;
      flush();
    };
    const stopped = () => close();
    const aborted = () => close();
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        store.on("change", publish);
        store.on("sessions", checkSession);
        store.on("close", stopped);
        c.req.raw.signal.addEventListener("abort", aborted, { once: true });
        if (c.req.raw.signal.aborted) {
          close();
          return;
        }
        heartbeat = setInterval(() => {
          if (!closed && checkSession() && (controller.desiredSize ?? 0) > 0)
            controller.enqueue(encoder.encode(": keepalive\n\n"));
        }, 15_000);
        heartbeat.unref();
        publish();
      },
      pull: flush,
      cancel: () => close(),
    });
    c.header("Content-Type", "text/event-stream");
    c.header("X-Accel-Buffering", "no");
    c.header("Connection", "keep-alive");
    return c.body(stream);
  });
  app.get("/api/resources", async (c) =>
    c.json({
      sources: await Promise.all(
        store.list<Source>("source").map((s) => providers.listResources(s)),
      ),
    }),
  );
  app.post("/api/sources", async (c) => {
    const s = sourceSchema.parse(await c.req.json());
    if (s.id) return c.json({ error: "ID is assigned by the server" }, 400);
    providers.validateSource({ ...s, id: s.id ?? "new" });
    return c.json(store.put("source", s), 201);
  });
  app.patch("/api/sources/:id", async (c) => {
    const id = c.req.param("id");
    const patch = await c.req.json();
    const previous = source(id);
    const s = sourceSchema.parse({
      ...previous,
      ...patch,
      id,
    });
    providers.validateSource({ ...s, id });
    if (sourceConnectionKey({ ...s, id }) !== sourceConnectionKey(previous)) {
      await terminals.closeSource(id);
      await options.closeOpenBridge?.(id);
      await providers.closeProviderConnections(id);
    }
    return c.json(store.put("source", s));
  });
  app.delete("/api/sources/:id", async (c) => {
    const id = c.req.param("id");
    source(id);
    await terminals.closeSource(id);
    await options.closeOpenBridge?.(id);
    await providers.closeProviderConnections(id);
    store.remove("source", id);
    return c.json({ ok: true });
  });
  app.post("/api/canvases", async (c) => {
    const value = canvasSchema.parse(await c.req.json());
    if (value.id) return c.json({ error: "ID is assigned by the server" }, 400);
    return c.json(store.canvasView(store.put("canvas", value)), 201);
  });
  app.on(["PUT", "PATCH"], "/api/canvases/:id", async (c) => {
    const id = c.req.param("id");
    if (id === "overview")
      return c.json({ error: "Overview is read-only" }, 403);
    const patch = await c.req.json();
    const canvas = store.get<Canvas>("canvas", id);
    if (!canvas) return c.json({ error: "Canvas not found" }, 404);
    return c.json(
      store.canvasView(
        store.put(
          "canvas",
          canvasSchema.parse({
            ...canvas,
            ...patch,
            id,
          }),
        ),
      ),
    );
  });
  app.delete("/api/canvases/:id", (c) => {
    if (c.req.param("id") === "overview")
      return c.json({ error: "Overview is read-only" }, 403);
    store.remove("canvas", c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/api/canvases/:id/nodes", async (c) => {
    const id = c.req.param("id");
    if (id === "overview")
      return c.json({ error: "Overview is read-only" }, 403);
    const { nodes } = nodeListSchema.parse(await c.req.json());
    const canvas = store.get<Canvas>("canvas", id);
    if (!canvas) return c.json({ error: "Canvas not found" }, 404);
    for (const node of nodes)
      if (
        !canvas.nodes.some(
          (existing) =>
            existing.id === node.id ||
            (isTerminalNode(existing) && isTerminalNode(node) &&
              existing.sourceId === node.sourceId && existing.windowId === node.windowId),
        )
      )
        canvas.nodes.push(node);
    return c.json(
      store.canvasView(store.put("canvas", canvasSchema.parse(canvas))),
    );
  });
  app.post("/api/canvases/:id/notes", async (c) => {
    const id = c.req.param("id");
    if (id === "overview") return c.json({ error: "Overview is read-only" }, 403);
    const value = noteCreateSchema.parse(await c.req.json());
    const canvas = store.get<Canvas>("canvas", id);
    if (!canvas) return c.json({ error: "Canvas not found" }, 404);
    const note = {
      id: randomUUID(), type: "note" as const,
      ...value,
    };
    canvas.nodes.push(note);
    return c.json(store.canvasView(store.put("canvas", canvasSchema.parse(canvas))), 201);
  });
  app.patch("/api/canvases/:id/notes/:node", async (c) => {
    const id = c.req.param("id"), nodeId = c.req.param("node");
    if (id === "overview") return c.json({ error: "Overview is read-only" }, 403);
    const patch = notePatchSchema.parse(await c.req.json());
    const canvas = store.get<Canvas>("canvas", id);
    if (!canvas) return c.json({ error: "Canvas not found" }, 404);
    const node = canvas.nodes.find((item) => item.id === nodeId);
    if (!node || node.type !== "note") return c.json({ error: "Note not found" }, 404);
    Object.assign(node, patch);
    return c.json(store.canvasView(store.put("canvas", canvasSchema.parse(canvas))));
  });
  app.patch("/api/canvases/:id/layout", async (c) => {
    const id = c.req.param("id");
    if (id === "overview")
      return c.json({ error: "Overview is read-only" }, 403);
    const { nodes } = layoutSchema.parse(await c.req.json());
    const canvas = store.get<Canvas>("canvas", id);
    if (!canvas) return c.json({ error: "Canvas not found" }, 404);
    const changes = new Map(nodes.map((node) => [node.id, node]));
    for (const node of canvas.nodes) {
      const patch = changes.get(node.id);
      if (isTerminalNode(node) && patch && (patch.width !== undefined || patch.height !== undefined))
        store.setWindowSize(node.sourceId, node.windowId, {
          ...(patch.width === undefined ? {} : { width: patch.width }),
          ...(patch.height === undefined ? {} : { height: patch.height }),
        });
    }
    canvas.nodes = canvas.nodes.map((node) => ({
      ...node,
      ...changes.get(node.id),
    }));
    return c.json(
      store.canvasView(store.put("canvas", canvasSchema.parse(canvas))),
    );
  });
  app.delete("/api/canvases/:id/nodes/:node", (c) => {
    const id = c.req.param("id");
    if (id === "overview")
      return c.json({ error: "Overview is read-only" }, 403);
    const canvas = store.get<Canvas>("canvas", id);
    if (!canvas) return c.json({ error: "Canvas not found" }, 404);
    canvas.nodes = canvas.nodes.filter(
      (node) => node.id !== c.req.param("node"),
    );
    return c.json(store.canvasView(store.put("canvas", canvas)));
  });
  app.put("/api/canvases/:id/background", async (c) => {
    const id = c.req.param("id");
    if (!store.get<Canvas>("canvas", id))
      return c.json({ error: "Canvas not found" }, 404);
    const rawOpacity = c.req.query("opacity");
    const opacity =
      rawOpacity === undefined
        ? undefined
        : z
            .string()
            .trim()
            .min(1)
            .transform(Number)
            .pipe(opacitySchema)
            .parse(rawOpacity);
    const image = await readBackground(c.req.raw);
    validateBackground(image, backgroundContentType(c.req.header("content-type")));
    // A canvas can be deleted while the upload is being read.
    const canvas = store.get<Canvas>("canvas", id);
    if (!canvas) return c.json({ error: "Canvas not found" }, 404);
    store.setCanvasBackground(
      id,
      image,
      opacity ??
        store.canvasView(canvas).background?.opacity ??
        DEFAULT_BACKGROUND_OPACITY,
    );
    return c.json(store.canvasView(canvas));
  });
  app.patch("/api/canvases/:id/background", async (c) => {
    const id = c.req.param("id");
    const canvas = store.get<Canvas>("canvas", id);
    if (!canvas) return c.json({ error: "Canvas not found" }, 404);
    const { opacity } = backgroundOpacitySchema.parse(await c.req.json());
    if (!store.canvasView(canvas).background)
      return c.json({ error: "Background not found" }, 404);
    store.setCanvasBackgroundOpacity(id, opacity);
    return c.json(store.canvasView(canvas));
  });
  app.delete("/api/canvases/:id/background", (c) => {
    const id = c.req.param("id");
    const canvas = store.get<Canvas>("canvas", id);
    if (!canvas) return c.json({ error: "Canvas not found" }, 404);
    store.removeCanvasBackground(id);
    return c.json(store.canvasView(canvas));
  });
  app.get("/api/backgrounds/:id", (c) => {
    const image = store.getBackground(c.req.param("id"));
    if (!image) return c.json({ error: "Background not found" }, 404);
    c.header("Content-Type", storedBackgroundContentType(image));
    c.header("Content-Length", String(image.byteLength));
    c.header("Cross-Origin-Resource-Policy", "same-origin");
    return c.body(image as Uint8Array<ArrayBuffer>);
  });
  app.post("/api/sources/:id/spaces", async (c) => {
    const { name, sourceSpaceId } = createSpaceSchema.parse(await c.req.json());
    return c.json(await providers.createSpace(source(c.req.param("id")), name, sourceSpaceId), 201);
  });
  app.patch("/api/sources/:id/spaces/:space", async (c) => {
    const { name } = nameSchema.parse(await c.req.json());
    await providers.renameSpace(
      source(c.req.param("id")),
      c.req.param("space"),
      name,
    );
    return c.json({ ok: true });
  });
  app.delete("/api/sources/:id/spaces/:space", async (c) => {
    await providers.closeSpace(source(c.req.param("id")), c.req.param("space"));
    return c.json({ ok: true });
  });
  app.post("/api/sources/:id/spaces/:space/windows", async (c) => {
    const { name } = createWindowSchema.parse(await c.req.json());
    return c.json(await providers.createWindow(
      source(c.req.param("id")),
      c.req.param("space"),
      name,
    ), 201);
  });
  app.patch("/api/sources/:id/spaces/:space/windows/:window", async (c) => {
    const { name } = nameSchema.parse(await c.req.json());
    await providers.renameWindow(
      source(c.req.param("id")),
      c.req.param("space"),
      c.req.param("window"),
      name,
    );
    return c.json({ ok: true });
  });
  app.delete("/api/sources/:id/spaces/:space/windows/:window", async (c) => {
    await providers.closeWindow(
      source(c.req.param("id")),
      c.req.param("space"),
      c.req.param("window"),
    );
    return c.json({ ok: true });
  });
  app.onError((error, c) => {
    if (error instanceof BackgroundError)
      return c.json({ error: error.message }, error.status);
    if (error instanceof z.ZodError)
      return c.json(
        {
          error: error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        },
        400,
      );
    return c.json({ error: error.message }, 400);
  });
  return app;
}
