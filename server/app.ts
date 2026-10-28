import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { verifyPassword } from "./auth.ts";
import {
  Store,
  sourceSchema,
  canvasSchema,
  type Source,
  type Canvas,
} from "./state.ts";
import * as providers from "./providers.ts";
import type { TerminalManager } from "./terminals.ts";
import {
  BackgroundError,
  DEFAULT_BACKGROUND_OPACITY,
  backgroundContentType,
  normalizeBackground,
  readBackground,
} from "./backgrounds.ts";
const nameSchema = z
  .object({ name: z.string().trim().min(1).max(100) })
  .strict();
const opacitySchema = z.number().finite().min(0).max(1);
const backgroundOpacitySchema = z.object({ opacity: opacitySchema }).strict();
const isBackgroundUpload = (method: string, path: string) =>
  method === "PUT" && /^\/api\/canvases\/[^/]+\/background$/.test(path);
export type Account = { username: string; passwordHash: string };
export function createApp(
  store: Store,
  account: Account,
  terminals: TerminalManager,
  options: { secureCookie?: boolean } = {},
) {
  const app = new Hono();
  const attempts = new Map<string, { count: number; until: number }>();
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      const origin = c.req.header("origin");
      if (origin) {
        try {
          if (new URL(origin).host !== c.req.header("host"))
            return c.json({ error: "Request origin rejected" }, 403);
        } catch {
          return c.json({ error: "Request origin rejected" }, 403);
        }
      }
    }
    if (
      !["/api/login", "/api/session"].includes(c.req.path) &&
      !store.hasSession(getCookie(c, "canvas_session") ?? "")
    )
      return c.json({ error: "Please sign in" }, 401);
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      if (isBackgroundUpload(c.req.method, c.req.path))
        backgroundContentType(c.req.header("content-type"));
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
    isBackgroundUpload(c.req.method, c.req.path)
      ? next()
      : jsonBodyLimit(c, next),
  );
  app.get("/api/session", (c) =>
    c.json({
      authenticated: store.hasSession(getCookie(c, "canvas_session") ?? ""),
      username: account.username,
    }),
  );
  app.post("/api/login", async (c) => {
    const input = z
      .object({ username: z.string().max(200), password: z.string().max(1024) })
      .parse(await c.req.json());
    const key = "account",
      now = Date.now(),
      prior = attempts.get(key);
    if (prior && prior.until > now && prior.count >= 10)
      return c.json(
        { error: "Too many attempts. Try again in a minute." },
        429,
      );
    if (
      input.username !== account.username ||
      !verifyPassword(input.password, account.passwordHash)
    ) {
      attempts.set(key, {
        count: prior && prior.until > now ? prior.count + 1 : 1,
        until: prior && prior.until > now ? prior.until : now + 60_000,
      });
      return c.json({ error: "Incorrect username or password" }, 401);
    }
    attempts.delete(key);
    const old = getCookie(c, "canvas_session");
    if (old) store.removeSession(old);
    const token = randomBytes(32).toString("base64url");
    store.addSession(token);
    setCookie(c, "canvas_session", token, {
      httpOnly: true,
      sameSite: "Strict",
      secure: options.secureCookie || new URL(c.req.url).protocol === "https:",
      path: "/",
      maxAge: 7 * 86400,
    });
    return c.json({ authenticated: true, username: account.username });
  });
  app.post("/api/logout", async (c) => {
    store.removeSession(getCookie(c, "canvas_session") ?? "");
    deleteCookie(c, "canvas_session", { path: "/" });
    await terminals.closeAll();
    providers.closeStatusObservers();
    return c.json({ ok: true });
  });
  const source = (id: string) => {
    const result = store.get<Source>("source", id);
    if (!result) throw new Error("Source not found");
    return result;
  };
  app.get("/api/state", (c) =>
    c.json({
      sources: store.list<Source>("source"),
      canvases: store
        .list<Canvas>("canvas")
        .map((canvas) => store.canvasView(canvas)),
    }),
  );
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
    source(id);
    const s = sourceSchema.parse({
      ...source(id),
      ...(await c.req.json()),
      id,
    });
    providers.validateSource({ ...s, id });
    await terminals.closeSource(id);
    providers.disposeStatusSource(id);
    return c.json(store.put("source", s));
  });
  app.delete("/api/sources/:id", async (c) => {
    const id = c.req.param("id");
    source(id);
    await terminals.closeSource(id);
    providers.disposeStatusSource(id);
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
  app.put("/api/canvases/:id/background", async (c) => {
    const id = c.req.param("id");
    if (id === "overview")
      return c.json({ error: "Overview is read-only" }, 403);
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
    const image = await normalizeBackground(
      await readBackground(c.req.raw),
      backgroundContentType(c.req.header("content-type")),
    );
    // A canvas can be deleted while the image is being decoded.
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
    if (id === "overview")
      return c.json({ error: "Overview is read-only" }, 403);
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
    if (id === "overview")
      return c.json({ error: "Overview is read-only" }, 403);
    const canvas = store.get<Canvas>("canvas", id);
    if (!canvas) return c.json({ error: "Canvas not found" }, 404);
    store.removeCanvasBackground(id);
    return c.json(store.canvasView(canvas));
  });
  app.get("/api/backgrounds/:id", (c) => {
    const image = store.getBackground(c.req.param("id"));
    if (!image) return c.json({ error: "Background not found" }, 404);
    c.header("Content-Type", "image/webp");
    c.header("Content-Length", String(image.byteLength));
    c.header("Cross-Origin-Resource-Policy", "same-origin");
    return c.body(image as Uint8Array<ArrayBuffer>);
  });
  app.post("/api/sources/:id/spaces", async (c) => {
    const { name } = nameSchema.parse(await c.req.json());
    await providers.createSpace(source(c.req.param("id")), name);
    return c.json({ ok: true });
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
    const { name } = nameSchema.parse(await c.req.json());
    await providers.createWindow(
      source(c.req.param("id")),
      c.req.param("space"),
      name,
    );
    return c.json({ ok: true });
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
