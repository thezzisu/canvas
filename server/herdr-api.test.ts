import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverHerdrPython, herdrApiRequest, herdrSocketPaths, localHerdrSockets, parseHerdrSockets, validateHerdrLocation } from "./herdr/api.ts";
import { createApp } from "./app.ts";
import { Store, type Source } from "./state.ts";
import type { TerminalManager } from "./terminals.ts";

test("herdr socket paths follow release session/XDG rules with explicit overrides", () => {
  const environment = { HOME: "/fixture/user", XDG_CONFIG_HOME: "/fixture/config" };
  assert.deepEqual(herdrSocketPaths({}, environment), { api: "/fixture/config/herdr/herdr.sock", client: "/fixture/config/herdr/herdr-client.sock" });
  assert.equal(herdrSocketPaths({ herdrSession: "work" }, environment).api, "/fixture/config/herdr/sessions/work/herdr.sock");
  assert.equal(herdrSocketPaths({ herdrSession: "default" }, { HOME: "/fixture/user" }).api, "/fixture/user/.config/herdr/herdr.sock");
  assert.deepEqual(herdrSocketPaths({ herdrSocket: "/custom/team.sock" }, {}), { api: "/custom/team.sock", client: "/custom/team-client.sock" });
  assert.equal(herdrSocketPaths({ herdrSocket: "/custom/team.endpoint" }, {}).client, "/custom/team-client.sock");
  for (const herdrSocket of ["relative.sock", "/tmp/a:b.sock", "/tmp/a\n.sock"])
    assert.throws(() => validateHerdrLocation({ herdrSocket }));
  for (const herdrSession of ["..", ".", "../../other", "name with space", "a".repeat(65)])
    assert.throws(() => validateHerdrLocation({ herdrSession }));
  assert.doesNotThrow(() => validateHerdrLocation({ herdrSession: "_work.1" }));
  assert.throws(() => parseHerdrSockets('{"api":"relative","client":"/tmp/client.sock"}'));
});

test("direct herdr JSON API handles fragmented responses, errors, bounds and timeouts", async t => {
  const root = await mkdtemp(join(tmpdir(), "cv-api-")), clients = new Set<Socket>();
  const server = createServer(socket => {
    clients.add(socket); socket.on("close", () => clients.delete(socket)); socket.on("error", () => {});
    let input = "";
    socket.on("data", chunk => {
      input += chunk.toString(); if (!input.includes("\n")) return;
      const request = JSON.parse(input.split("\n")[0]!);
      if (request.method === "timeout") return;
      if (request.method === "partial") { socket.end('{"id":'); return; }
      if (request.method === "oversize") { socket.end("x".repeat(200)); return; }
      const response = request.method === "error" ? { id: request.id, error: { code: "invalid", message: "fixture error" } }
        : request.method === "wrong-id" ? { id: "another", result: {} } : { id: request.id, result: { marker: "中文", params: request.params } };
      const bytes = Buffer.from(JSON.stringify(response) + "\n"), split = bytes.indexOf(Buffer.from("中文")) + 1;
      socket.write(bytes.subarray(0, split)); setTimeout(() => socket.end(bytes.subarray(split)), 5);
    });
  });
  const socketPath = join(root, "api.sock"); await new Promise<void>(resolve => server.listen(socketPath, resolve));
  t.after(async () => { for (const client of clients) client.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  assert.deepEqual(await herdrApiRequest(socketPath, "read", { label: "name ' ; $()" }), { marker: "中文", params: { label: "name ' ; $()" } });
  await assert.rejects(herdrApiRequest(socketPath, "error"), /fixture error/u);
  await assert.rejects(herdrApiRequest(socketPath, "wrong-id"), /Invalid herdr API response/u);
  await assert.rejects(herdrApiRequest(socketPath, "oversize", {}, { maxResponseBytes: 100 }), /too large/u);
  await assert.rejects(herdrApiRequest(socketPath, "partial"), /closed before/u);
  await assert.rejects(herdrApiRequest(socketPath, "timeout", {}, { timeoutMs: 40 }), /timed out/u);
});

test("local and SSH discovery agree on a named session without running a CLI", async t => {
  const root = await mkdtemp(join(tmpdir(), "cv-discover-")), config = join(root, "config ' custom"), location = { herdrSession: "_work.1" };
  const paths = herdrSocketPaths(location, { XDG_CONFIG_HOME: config });
  await mkdir(join(config, "herdr/sessions/_work.1"), { recursive: true });
  const sockets = [createServer(socket => socket.destroy()), createServer(socket => socket.destroy())];
  await Promise.all(sockets.map((server, index) => new Promise<void>(resolve => server.listen(index ? paths.client : paths.api, resolve))));
  t.after(async () => { await Promise.all(sockets.map(server => new Promise<void>(resolve => server.close(() => resolve())))); await rm(root, { recursive: true, force: true }); });
  const before = process.env.XDG_CONFIG_HOME;
  try {
    process.env.XDG_CONFIG_HOME = config;
    assert.deepEqual(await localHerdrSockets(location), paths);
    assert.deepEqual(parseHerdrSockets(execFileSync("/usr/bin/python3", ["-c", discoverHerdrPython, JSON.stringify(location)], { env: { HOME: root, XDG_CONFIG_HOME: config }, encoding: "utf8" })), paths);
    await assert.rejects(localHerdrSockets({ herdrSession: "missing" }), /ENOENT/u);
  } finally { if (before === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = before; }
});

test("herdr provider discovers sockets and performs resource CRUD without executable dispatch", async t => {
  const { closeProviderConnections, closeSpace, closeWindow, createSpace, createWindow, listResources, nativeSocketForSource, openTerminal, renameSpace, renameWindow } = await import("./providers.ts");
  const root = await mkdtemp(join(tmpdir(), "cv-native-api-")), directory = join(root, "quoted ' session"), clients = new Set<Socket>();
  await mkdir(directory);
  const paths = herdrSocketPaths({ herdrSocket: join(directory, "herdr.sock") }), requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const snapshot = {
    workspaces: [{ workspace_id: "w1", label: "Workspace" }],
    tabs: [{ workspace_id: "w1", tab_id: "w1:t1", label: "Window", agent_status: "idle" },
      { workspace_id: "w1", tab_id: "w1:t2", label: "Empty", agent_status: "done" }],
    panes: [{ tab_id: "w1:t1", pane_id: "w1:p1", agent_status: "working", focused: true },
      { tab_id: "w1:t1", pane_id: "w1:p2", agent_status: "done", focused: false }],
  };
  let malformedCreation = false;
  const api = createServer(socket => {
    clients.add(socket); socket.on("close", () => clients.delete(socket)); socket.on("error", () => {});
    let input = ""; socket.on("data", chunk => {
      input += chunk.toString(); if (!input.includes("\n")) return;
      const request = JSON.parse(input.split("\n")[0]!); requests.push({ method: request.method, params: request.params });
      const result = request.method === "session.snapshot" ? { type: "session_snapshot", snapshot }
        : request.method === "workspace.create" && !malformedCreation ? { type: "workspace_created", tab: { workspace_id: "w2", tab_id: "w2:t1" } }
        : request.method === "tab.create" && !malformedCreation ? { type: "tab_created", tab: { workspace_id: request.params.workspace_id, tab_id: `${request.params.workspace_id}:t3` } }
        : { type: "ok" };
      socket.end(JSON.stringify({ id: request.id, result }) + "\n");
    });
  });
  const endpoint = createServer(socket => { clients.add(socket); socket.on("close", () => clients.delete(socket)); socket.on("error", () => {}); });
  await Promise.all([new Promise<void>(resolve => api.listen(paths.api, resolve)), new Promise<void>(resolve => endpoint.listen(paths.client, resolve))]);
  t.after(async () => { await closeProviderConnections("native-api"); for (const client of clients) client.destroy(); await Promise.all([api, endpoint].map(server => new Promise<void>(resolve => server.close(() => resolve())))); await rm(root, { recursive: true, force: true }); });
  const source: Source = { id: "native-api", name: "Native", transport: "local", herdrSocket: paths.api };
  assert.deepEqual(await localHerdrSockets(source), paths);
  assert.deepEqual(parseHerdrSockets(execFileSync("python3", ["-c", discoverHerdrPython, JSON.stringify({ herdrSocket: paths.api })], { encoding: "utf8" })), paths);
  assert.equal(await nativeSocketForSource(source), paths.api);
  const resources = await listResources(source); assert.equal(resources.status, "online");
  const windows = resources.spaces[0]!.windows;
  assert.deepEqual(windows.map(window => window.id), ["w1:t1", "w1:t2"], "resources retain native tab order");
  assert.equal(windows[0]!.panes[0]!.status, "working");
  assert.equal(windows[0]!.panes[1]!.status, "done");
  assert.equal(windows[0]!.status, "done", "completed pane outranks concurrent work in the window summary");
  assert.equal(windows[1]!.status, "done", "tabs without pane details retain their native status");
  snapshot.panes[1]!.agent_status = "blocked";
  assert.equal((await listResources(source)).spaces[0]!.windows[0]!.status, "attention");
  const handle = await openTerminal(source, "w1", "w1:t1");
  assert.equal(typeof handle.connect, "function"); await handle.cleanup();
  const label = "name ' ; $() 中文";
  assert.deepEqual(await createSpace(source, label), { spaceId: "w2", windowId: "w2:t1" });
  await renameSpace(source, "w1", label);
  assert.deepEqual(await createWindow(source, "w1", label), { spaceId: "w1", windowId: "w1:t3" });
  await renameWindow(source, "w1", "w1:t1", label); await closeWindow(source, "w1", "w1:t1"); await closeSpace(source, "w1");
  assert.deepEqual(requests.filter(request => request.method !== "session.snapshot"), [
    { method: "workspace.create", params: { label, focus: false } }, { method: "workspace.rename", params: { workspace_id: "w1", label } },
    { method: "tab.create", params: { workspace_id: "w1", label, focus: false } }, { method: "tab.rename", params: { tab_id: "w1:t1", label } },
    { method: "tab.close", params: { tab_id: "w1:t1" } }, { method: "workspace.close", params: { workspace_id: "w1" } },
  ]);
  await createSpace(source);
  assert.deepEqual(requests.at(-1), { method: "workspace.create", params: { focus: false } });
  await createSpace(source, "  ", "w1");
  assert.deepEqual(requests.at(-1), { method: "workspace.create", params: { source_workspace_id: "w1", focus: false } });
  await createWindow(source, "w1", "  ");
  assert.deepEqual(requests.at(-1), { method: "tab.create", params: { workspace_id: "w1", focus: false } });
  await assert.rejects(createSpace(source, undefined, "missing"), /Space no longer exists/u);
  assert.equal(requests.at(-1)?.method, "session.snapshot", "a stale parent must not create in another workspace");
  malformedCreation = true;
  await assert.rejects(createWindow(source, "w1"), /Unexpected herdr creation response/u);
  malformedCreation = false;

  const store = new Store(join(root, "state.db"));
  try {
    store.put("source", source);
    store.addSession("creation-fixture");
    const app = createApp(store, { username: "fixture", passwordHash: "unused" }, {} as TerminalManager);
    const call = (path: string, method: string, body: unknown) => app.request(`http://localhost/api/sources/${source.id}/${path}`, {
      method,
      headers: { Host: "localhost", Origin: "http://localhost", Cookie: "canvas_session=creation-fixture", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    for (const body of [{}, { name: "  ", sourceSpaceId: "w1" }]) {
      const response = await call("spaces", "POST", body);
      assert.equal(response.status, 201);
      assert.deepEqual(await response.json(), { spaceId: "w2", windowId: "w2:t1" });
      assert.equal(Object.hasOwn(requests.at(-1)!.params, "label"), false, "blank names preserve native automatic naming");
    }
    const createdTab = await call("spaces/w1/windows", "POST", {});
    assert.equal(createdTab.status, 201);
    assert.deepEqual(await createdTab.json(), { spaceId: "w1", windowId: "w1:t3" });
    for (const path of ["spaces/w1", "spaces/w1/windows/w1:t1"])
      for (const body of [{}, { name: "  " }]) assert.equal((await call(path, "PATCH", body)).status, 400, "renaming still requires a name");
    assert.equal((await call("spaces", "POST", { sourceSpaceId: "missing" })).status, 400);
    assert.equal((await call("spaces/w1/windows", "POST", { name: 42 })).status, 400);
  } finally { store.close(); }
});
