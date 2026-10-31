import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.ts";
import { Store, sourceConnectionKey, type Source } from "./state.ts";
import { hashPassword } from "./auth.ts";
import type { TerminalManager } from "./terminals.ts";
import { buildInfo } from "./build-info.ts";

test("authentication, CSRF rejection and persistent canvas CRUD", async () => {
  const dir = mkdtempSync(join(tmpdir(), "canvas-unit-"));
  const store = new Store(join(dir, "state.db"));
  let closed = 0;
  const app = createApp(
    store,
    { username: "test", passwordHash: hashPassword("fixture-password") },
    {
      closeAll: async () => {
        closed++;
      },
      closeSource: async () => {},
    } as unknown as TerminalManager,
  );
  const call = (
    path: string,
    method = "GET",
    body?: unknown,
    token?: string,
    origin = "http://localhost",
  ) =>
    app.request(`http://localhost${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Host: "localhost",
        Origin: origin,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    const probe = await call("/api/session");
    assert.equal(probe.headers.get("cache-control"), "no-store");
    assert.deepEqual(await probe.json(), { authenticated: false, username: "test", server: buildInfo });
    assert.equal((await call("/api/state")).status, 401);
    assert.equal(
      (
        await call("/api/login", "POST", {
          username: "test",
          password: "wrong",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await call(
          "/api/login",
          "POST",
          { username: "test", password: "fixture-password" },
          undefined,
          "https://evil.example",
        )
      ).status,
      403,
    );
    const login = await call("/api/login", "POST", {
      username: "test",
      password: "fixture-password",
    });
    assert.equal(login.status, 200);
    const { token, expiresAt, server } = await login.json();
    assert.deepEqual(server, buildInfo);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/u);
    assert(expiresAt > Date.now() + 6 * 86400_000);
    assert.equal(login.headers.get("set-cookie"), null);
    assert.equal((await app.request("http://localhost/api/state", { headers: { Cookie: `canvas_session=${token}` } })).status, 401);
    assert.deepEqual(await (await call("/api/session", "GET", undefined, token)).json(), { authenticated: true, username: "test", server: buildInfo });
    const created = await call(
      "/api/canvases",
      "POST",
      { name: "Investigation", nodes: [] },
      token,
    );
    assert.equal(created.status, 201);
    const canvas = (await created.json()) as { id: string };
    assert.equal(
      (
        await call(
          `/api/canvases/${canvas.id}`,
          "PATCH",
          { name: "Renamed", nodes: [] },
          token,
        )
      ).status,
      200,
    );
    assert.equal(store.list<{ name: string }>("canvas")[0]!.name, "Renamed");
    assert.equal(
      (
        await call(
          "/api/sources",
          "POST",
          {
            name: "Bad",
            transport: "ssh",
            target: "-oProxyCommand=evil",
          },
          token,
        )
      ).status,
      400,
    );
    assert.equal((await call("/api/logout", "POST", {}, token)).status, 200);
    assert.equal(closed, 0, "logout must preserve other sessions' terminals");
    assert.equal(
      (await call("/api/state", "GET", undefined, token)).status,
      401,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("empty herdr settings explicitly clear overrides while omitted PATCH fields remain unchanged", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "canvas-source-clear-"));
  const store = new Store(join(dir, "state.db"));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.addSession("source-clear");
  const closed: string[] = [];
  const app = createApp(store, { username: "fixture", passwordHash: "unused" }, {
    closeSource: async (id: string) => { closed.push(id); },
  } as unknown as TerminalManager);
  const call = (path: string, method = "GET", body?: unknown) => app.request(`http://localhost${path}`, {
    method,
    headers: { Host: "localhost", Origin: "http://localhost", Authorization: "Bearer source-clear", "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const created = await call("/api/sources", "POST", {
    name: "Herdr", transport: "local", herdrSession: "named", herdrSocket: "/fixture/custom.sock",
  });
  assert.equal(created.status, 201);
  const original = await created.json();
  const path = `/api/sources/${original.id}`;
  const renamed = await call(path, "PATCH", { ...original, name: "Renamed", target: "", sshIdentityFile: "", sshKnownHostsFile: "" });
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).herdrSocket, "/fixture/custom.sock");
  assert.equal(closed.length, 0);
  const cleared = await call(path, "PATCH", { herdrSession: "   ", herdrSocket: "" });
  assert.equal(cleared.status, 200);
  const clearBody = await cleared.json();
  for (const body of [clearBody, store.get<Record<string, unknown>>("source", original.id)!]) {
    assert.equal(Object.hasOwn(body, "herdrSession"), false);
    assert.equal(Object.hasOwn(body, "herdrSocket"), false);
    assert.equal(body.name, "Renamed");
  }
  assert.deepEqual(closed, [original.id]);
  const state = await (await call("/api/state")).json();
  const source = state.sources.find((value: { id: string }) => value.id === original.id);
  assert.equal(Object.hasOwn(source, "herdrSession"), false);
  assert.equal(Object.hasOwn(source, "herdrSocket"), false);
  for (const body of [{ herdrSocket: "relative.sock" }, { herdrSession: ".." }, { herdrSocket: null }])
    assert.equal((await call(path, "PATCH", body)).status, 400);
  assert.equal(Object.hasOwn(store.get<Record<string, unknown>>("source", original.id)!, "herdrSocket"), false);
  const defaults = await call("/api/sources", "POST", {
    name: "Default", transport: "local", herdrSession: "", herdrSocket: "   ",
  });
  assert.equal(defaults.status, 201);
  const defaultBody = await defaults.json();
  assert.equal(Object.hasOwn(defaultBody, "herdrSession"), false);
  assert.equal(Object.hasOwn(defaultBody, "herdrSocket"), false);
});

test("connection identity treats blank form defaults equivalently and preserves meaningful SSH paths", () => {
  const local: Source = { id: "fixture", name: "Local", transport: "local" };
  assert.equal(sourceConnectionKey(local), sourceConnectionKey({ ...local, name: "Renamed",
    target: "unused-host", sshIdentityFile: "/unused/key", sshKnownHostsFile: "/unused/known_hosts", herdrSession: "", herdrSocket: "" }));
  const remote: Source = { ...local, transport: "ssh", target: "fixture.invalid" };
  assert.equal(sourceConnectionKey(remote), sourceConnectionKey({ ...remote, name: "Renamed",
    sshIdentityFile: "", sshKnownHostsFile: "", herdrSession: "", herdrSocket: "" }));
  for (const key of ["sshIdentityFile", "sshKnownHostsFile"] as const) {
    assert.notEqual(sourceConnectionKey(remote), sourceConnectionKey({ ...remote, [key]: " " }));
    assert.notEqual(sourceConnectionKey({ ...remote, [key]: "/fixture/path " }), sourceConnectionKey({ ...remote, [key]: "/fixture/path" }));
  }
  for (const patch of [{ id: "other" }, { target: "other.invalid" }, { transport: "local" as const },
    { herdrSession: "work" }, { herdrSocket: "/fixture/other.sock" }])
    assert.notEqual(sourceConnectionKey(remote), sourceConnectionKey({ ...remote, ...patch }));
});
