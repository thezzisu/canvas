import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.ts";
import { Store } from "./state.ts";
import { hashPassword } from "./auth.ts";
import type { TerminalManager } from "./terminals.ts";

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
    cookie?: string,
    origin = "http://localhost",
  ) =>
    app.request(`http://localhost${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Host: "localhost",
        Origin: origin,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
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
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    assert.match(login.headers.get("set-cookie")!, /HttpOnly/i);
    const created = await call(
      "/api/canvases",
      "POST",
      { name: "Investigation", nodes: [] },
      cookie,
    );
    assert.equal(created.status, 201);
    const canvas = (await created.json()) as { id: string };
    assert.equal(
      (
        await call(
          `/api/canvases/${canvas.id}`,
          "PATCH",
          { name: "Renamed", nodes: [] },
          cookie,
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
            type: "tmux",
            transport: "ssh",
            target: "-oProxyCommand=evil",
          },
          cookie,
        )
      ).status,
      400,
    );
    assert.equal((await call("/api/logout", "POST", {}, cookie)).status, 200);
    assert.equal(closed, 0, "logout must preserve other sessions' terminals");
    assert.equal(
      (await call("/api/state", "GET", undefined, cookie)).status,
      401,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
