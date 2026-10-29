import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "./app.ts";
import { Store, type SharedState, type Canvas } from "./state.ts";
import type { TerminalManager } from "./terminals.ts";

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "canvas-sync-"));
  const store = new Store(join(directory, "canvas.db"));
  let terminalShutdowns = 0;
  const app = createApp(
    store,
    { username: "fixture", passwordHash: "unused" },
    {
      closeAll: async () => {
        terminalShutdowns++;
      },
      closeSource: async () => {},
    } as unknown as TerminalManager,
  );
  store.addSession("first");
  store.addSession("second");
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    session = "first",
  ) =>
    app.request(`http://localhost${path}`, {
      method,
      headers: {
        Host: "localhost",
        Cookie: `canvas_session=${session}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  async function subscribe(session = "first") {
    const response = await request("/api/events", "GET", undefined, session);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const reader = response.body!.getReader();
    t.after(() => reader.cancel());
    return {
      cancel: () => reader.cancel(),
      async next() {
        let timer: ReturnType<typeof setTimeout>;
        try {
          const result = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("SSE message timed out")),
                2000,
              );
            }),
          ]);
          if (result.done) return { event: "closed", state: undefined };
          const text = new TextDecoder().decode(result.value);
          return {
            event: /^event: (.+)$/m.exec(text)?.[1],
            state: JSON.parse(
              /^data: (.+)$/m.exec(text)?.[1] || "{}",
            ) as SharedState,
          };
        } finally {
          clearTimeout(timer!);
        }
      },
    };
  }
  return {
    store,
    request,
    subscribe,
    get terminalShutdowns() {
      return terminalShutdowns;
    },
  };
}

test("authenticated browsers receive the same state and reconnect at the latest revision", async (t) => {
  const f = fixture(t);
  assert.equal(
    (await f.request("/api/events", "GET", undefined, "invalid")).status,
    401,
  );
  const first = await f.subscribe(),
    second = await f.subscribe("second");
  assert.deepEqual((await first.next()).state, (await second.next()).state);
  const created = (await (
    await f.request("/api/canvases", "POST", { name: "Shared", nodes: [] })
  ).json()) as Canvas;
  const a = (await first.next()).state!,
    b = (await second.next()).state!;
  assert.deepEqual(a, b);
  assert.equal(a.canvases[0]?.id, created.id);
  await f.request(`/api/canvases/${created.id}`, "PATCH", { name: "Renamed" });
  const renamed = (await first.next()).state!;
  assert.equal(renamed.canvases[0]?.name, "Renamed");
  assert.deepEqual(renamed, (await second.next()).state);
  assert.ok(renamed.revision > a.revision);
  await second.cancel();
  await f.request(`/api/canvases/${created.id}`, "DELETE");
  await first.next();
  const reconnected = await f.subscribe("second");
  assert.deepEqual((await reconnected.next()).state?.canvases, []);
});

test("slow readers receive the latest state without an unbounded mutation queue", async (t) => {
  const f = fixture(t),
    stream = await f.subscribe();
  for (let index = 0; index < 50; index++)
    f.store.put("canvas", {
      id: "coalesced-fixture",
      name: `Update ${index}`,
      nodes: [],
    });
  await stream.next();
  const latest = (await stream.next()).state!;
  assert.equal(latest.canvases[0]?.name, "Update 49");
  assert.equal(latest.revision, 50);
});

test("global font settings broadcast to both browsers without altering canvas documents", async t => {
  const f = fixture(t), first = await f.subscribe(), second = await f.subscribe('second')
  const baseline = (await first.next()).state!
  await second.next()
  const settings = { contentFont: { stack: [{ family: 'Example Local Mono' }, { family: 'monospace' }], ligatures: true } }
  assert.equal((await f.request('/api/settings', 'PATCH', settings)).status, 200)
  const a = (await first.next()).state!, b = (await second.next()).state!
  assert.deepEqual(a, b)
  assert.deepEqual(a.settings, settings)
  assert.deepEqual(a.canvases, baseline.canvases)
  assert.deepEqual(a.windowSizes, baseline.windowSizes)
  assert.equal(f.terminalShutdowns, 0)
})

test("legacy font documents are normalized for browser snapshots without a migration write", async t => {
  const f = fixture(t)
  const original = JSON.stringify({ contentFont: { stack: [{ family: 'Maple Mono NF CN', variant: 'normal' }, { family: 'monospace' }], ligatures: true } })
  f.store.db.prepare("INSERT INTO documents(kind,id,body) VALUES('settings','global',?)").run(original)
  const canonical = { contentFont: { stack: [{ family: 'Maple Mono Normal NF CN' }, { family: 'monospace' }], ligatures: true } }
  const first = await f.subscribe(), second = await f.subscribe('second')
  const baseline = (await first.next()).state!
  assert.deepEqual(baseline, (await second.next()).state)
  assert.deepEqual(baseline.settings, canonical)
  assert.equal((await f.request('/api/settings', 'PATCH', canonical)).status, 200)
  assert.equal(f.store.revision, baseline.revision, 'readback save does not publish a spurious change')
  assert.equal(f.store.db.prepare("SELECT body FROM documents WHERE kind='settings' AND id='global'").get()!.body, original)
  const stale = await f.request('/api/settings', 'PATCH', JSON.parse(original))
  assert.equal(stale.status, 400, 'stale variant-bearing clients cannot restore the retired representation')
  const changed = { contentFont: { stack: [{ family: 'Maple Mono NF CN' }, ...canonical.contentFont.stack], ligatures: false } }
  assert.equal((await f.request('/api/settings', 'PATCH', changed)).status, 200)
  const a = (await first.next()).state!, b = (await second.next()).state!
  assert.deepEqual(a, b)
  assert.deepEqual(a.settings, changed)
  assert.deepEqual(a.canvases, baseline.canvases)
  assert.equal(f.terminalShutdowns, 0)
})

test("logout and expiry close only the affected browser subscriptions", async (t) => {
  const f = fixture(t),
    first = await f.subscribe(),
    second = await f.subscribe("second");
  await first.next();
  await second.next();
  assert.equal(f.store.listenerCount("change"), 2);
  assert.equal((await f.request("/api/logout", "POST")).status, 200);
  assert.equal((await first.next()).event, "unauthorized");
  assert.equal((await first.next()).event, "closed");
  assert.equal(f.store.listenerCount("change"), 1);
  assert.equal(f.terminalShutdowns, 0);
  f.store.put("canvas", { id: randomUUID(), name: "Other browser remains connected", nodes: [] });
  assert.equal((await second.next()).state?.canvases.length, 1);
  f.store.db.prepare("UPDATE sessions SET expires=0 WHERE id=?").run("second");
  f.store.emit("sessions");
  assert.equal((await second.next()).event, "unauthorized");
  assert.equal(f.store.listenerCount("change"), 0);
});

test("concurrent layout, membership and name edits merge against the latest canvas", async (t) => {
  const f = fixture(t),
    sourceId = randomUUID();
  const node = (id: string) => ({
    id,
    sourceId,
    spaceId: "space",
    windowId: id,
    x: 0,
    y: 0,
    width: 500,
    height: 300,
  });
  const canvas = f.store.put("canvas", {
    id: randomUUID(),
    name: "Shared",
    nodes: [node("first"), node("second")],
  });
  const path = `/api/canvases/${canvas.id}`;
  assert.equal(
    (
      await f.request(`${path}/layout`, "PATCH", {
        nodes: [{ id: "first", x: 42 }],
      })
    ).status,
    200,
  );
  await f.request(path, "PATCH", { name: "Renamed" }, "second");
  await f.request(
    `${path}/nodes`,
    "POST",
    { nodes: [node("third")] },
    "second",
  );
  await f.request(`${path}/layout`, "PATCH", {
    nodes: [{ id: "second", width: 720 }],
  });
  const shared = f.store.get<Canvas>("canvas", canvas.id)!;
  assert.equal(shared.name, "Renamed");
  assert.equal(shared.nodes.length, 3);
  assert.equal(shared.nodes[0]?.x, 42);
  assert.equal(shared.nodes[1]?.width, 720);
  await f.request(`${path}/nodes/first`, "DELETE", undefined, "second");
  await f.request(`${path}/layout`, "PATCH", {
    nodes: [{ id: "first", x: 99 }],
  });
  assert.equal(
    f.store
      .get<Canvas>("canvas", canvas.id)!
      .nodes.some((item) => item.id === "first"),
    false,
  );
  assert.equal(
    (await f.request("/api/canvases/overview/layout", "PATCH", { nodes: [] }))
      .status,
    403,
  );
  assert.equal(
    (await f.request("/api/canvases/overview/nodes", "POST", { nodes: [] }))
      .status,
    403,
  );
  assert.equal(
    (await f.request("/api/canvases/overview/nodes/first", "DELETE")).status,
    403,
  );
});
