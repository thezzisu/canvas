import test from "node:test";
import assert from "node:assert/strict";
import { GeometryController } from "./geometry.ts";
import type { NativeSize, TerminalCommand } from "./providers.ts";
import { NativeGeometryConflictError } from "./providers.ts";
function fixture() {
  let revision = 0;
  let native: NativeSize = { cols: 80, rows: 24, token: "0", policy: "latest" };
  const writes: NativeSize[] = [];
  const events: Array<{ owner?: object; token?: string; reason?: string }> = [];
  const errors: unknown[] = [];
  const applied: NativeSize[] = [];
  const external = (cols: number, rows: number, policy = native.policy) =>
    (native = { cols, rows, policy, token: String(++revision) });
  const provider: TerminalCommand = {
    file: "fixture",
    args: [],
    cleanup: async () => {},
    initialSize: native,
    readSize: async () => ({ ...native }),
    resize: async (cols, rows, expected) => {
      if (expected !== undefined && expected !== native.token)
        throw new NativeGeometryConflictError();
      external(cols, rows, "manual");
      writes.push({ ...native });
      return { ...native };
    },
    restoreSize: async (before, expected) => {
      if (expected === native.token) {
        external(before.cols, before.rows, before.policy);
        writes.push({ ...native });
      }
      return { ...native };
    },
    commitSize: async () => {},
  };
  const controller = new GeometryController(
    provider,
    native,
    (size) => applied.push({ ...size }),
    (lease, reason) => events.push({ ...lease, reason }),
    (_owner, error) => errors.push(error),
  );
  return {
    controller,
    provider,
    external,
    writes,
    events,
    errors,
    applied,
    get native() {
      return native;
    },
  };
}
test("focus expands real geometry, coalesces ownership, restores baseline and ignores stale tokens", async () => {
  const f = fixture(),
    a = {},
    b = {};
  f.controller.begin(a, "a", { cols: 140, rows: 45 });
  await f.controller.drain();
  assert.equal(f.native.cols, 140);
  f.controller.begin(b, "b", { cols: 160, rows: 52 });
  await f.controller.drain();
  assert.equal(f.native.cols, 160);
  await f.controller.end(a, "a");
  assert.equal(f.native.cols, 160);
  f.controller.update(a, "a", { cols: 180, rows: 60 });
  await f.controller.drain();
  assert.equal(f.native.cols, 160);
  assert.equal(f.controller.state(a).owned, false);
  assert.equal(f.controller.state(b).owned, true);
  await f.controller.end(b, "b");
  assert.deepEqual(
    { cols: f.native.cols, rows: f.native.rows, policy: f.native.policy },
    { cols: 80, rows: 24, policy: "latest" },
  );
  assert.equal(f.controller.state(b).active, false);
});
test("external resize, fast reversal and policy change invalidate restoration", async () => {
  for (const change of ["size", "reversal", "policy"]) {
    const f = fixture(),
      a = {};
    f.controller.begin(a, "a", { cols: 140, rows: 45 });
    await f.controller.drain();
    if (change === "size") f.external(110, 35);
    if (change === "reversal") {
      f.external(110, 35);
      f.external(140, 45);
    }
    if (change === "policy") f.external(140, 45, "largest");
    const expected = { ...f.native };
    const before = f.writes.length;
    f.controller.poll();
    await f.controller.drain();
    assert.equal(f.controller.state(a).active, false);
    f.controller.update(a, "a", { cols: 150, rows: 50 });
    await f.controller.end(a, "a");
    await f.controller.drain();
    assert.deepEqual(f.native, expected);
    assert.equal(f.writes.length, before);
    assert.ok(f.events.some((e) => e.reason === "external-resize"));
  }
});
test("new focus after external takeover uses external baseline; explicit persistent resize cancels old restore", async () => {
  const f = fixture(),
    a = {},
    b = {};
  f.controller.begin(a, "old", { cols: 140, rows: 45 });
  await f.controller.drain();
  f.external(111, 36);
  f.controller.begin(a, "new", { cols: 150, rows: 50 });
  await f.controller.drain();
  assert.equal(f.native.cols, 150);
  await f.controller.end(a, "old");
  assert.equal(f.native.cols, 150);
  await f.controller.end(a, "new");
  assert.equal(f.native.cols, 111);
  assert.equal(f.native.rows, 36);
  f.controller.begin(a, "third", { cols: 150, rows: 50 });
  await f.controller.drain();
  f.controller.persistent(b, { cols: 99, rows: 31 });
  await f.controller.drain();
  await f.controller.end(a, "third");
  assert.equal(f.native.cols, 99);
  assert.equal(f.native.rows, 31);
});
test("disconnect and shutdown restore owned geometry, while end before pending begin performs no writes", async () => {
  const f = fixture(),
    a = {};
  f.controller.begin(a, "cancel", { cols: 140, rows: 45 });
  await f.controller.end(a, "cancel");
  assert.equal(f.writes.length, 0);
  f.controller.begin(a, "live", { cols: 140, rows: 45 });
  await f.controller.drain();
  await f.controller.end(a);
  assert.equal(f.native.cols, 80);
  f.controller.begin(a, "shutdown", { cols: 140, rows: 45 });
  await f.controller.drain();
  await f.controller.close();
  assert.equal(f.native.cols, 80);
});
test("native compare-and-restore preserves a resize arriving after the final read", async () => {
  const f = fixture(),
    a = {};
  f.controller.begin(a, "live", { cols: 140, rows: 45 });
  await f.controller.drain();
  const restore = f.provider.restoreSize!;
  f.provider.restoreSize = async (before, expected) => {
    f.external(103, 37);
    return restore(before, expected);
  };
  await f.controller.end(a, "live");
  assert.equal(f.native.cols, 103);
  assert.equal(f.native.rows, 37);
});
test("native resize CAS failure yields to external state without claiming ownership", async () => {
  const f = fixture(),
    a = {};
  const resize = f.provider.resize!;
  f.provider.resize = async (cols, rows, expected) => {
    f.external(103, 37);
    return resize(cols, rows, expected);
  };
  f.controller.begin(a, "live", { cols: 140, rows: 45 });
  await f.controller.drain();
  assert.equal(f.native.cols, 103);
  assert.equal(f.controller.state(a).active, false);
  assert.equal(f.writes.length, 0);
  assert.equal(f.errors.length, 1);
});

test("restore prepares the passive client under native protection and follows an intervening external resize", async () => {
  const f = fixture(),
    owner = {};
  f.controller.begin(owner, "focus", { cols: 140, rows: 45 });
  await f.controller.drain();
  const restore = f.provider.restoreSize!;
  f.provider.restoreSize = async (before, expected, prepare) => {
    assert.equal(f.native.cols, 140);
    assert.ok(prepare);
    await prepare(before);
    assert.equal(f.applied.at(-1)?.cols, 80);
    assert.equal(
      f.native.cols,
      140,
      "preparation must not write native geometry",
    );
    f.external(103, 37);
    return restore(before, expected);
  };
  await f.controller.end(owner, "focus");
  assert.equal(f.native.cols, 103);
  assert.equal(f.applied.at(-1)?.cols, 103);
});

test("viewport and card resize bursts retain only the latest queued size", async () => {
  const f = fixture(),
    owner = {};
  f.controller.begin(owner, "focus", { cols: 140, rows: 45 });
  await f.controller.drain();
  const count = f.writes.length;
  for (let cols = 141; cols <= 180; cols++)
    f.controller.update(owner, "focus", { cols, rows: 50 });
  await f.controller.drain();
  assert.equal(f.native.cols, 180);
  assert.equal(f.writes.length, count + 1);
  await f.controller.end(owner, "focus");
  const restored = f.writes.length;
  for (let cols = 81; cols <= 120; cols++)
    f.controller.persistent(owner, { cols, rows: 30 });
  await f.controller.drain();
  assert.equal(f.native.cols, 120);
  assert.equal(f.writes.length, restored + 1);
});

test("queued updates from a previous focus cannot consume the new focus's latest viewport", async () => {
  const f = fixture(),
    owner = {};
  f.controller.begin(owner, "first", { cols: 140, rows: 45 });
  await f.controller.drain();
  f.controller.update(owner, "first", { cols: 150, rows: 45 });
  const ended = f.controller.end(owner, "first");
  f.controller.begin(owner, "second", { cols: 160, rows: 50 });
  f.controller.update(owner, "second", { cols: 170, rows: 55 });
  await ended;
  await f.controller.drain();
  assert.equal(f.native.cols, 170);
  assert.equal(f.native.rows, 55);
  assert.equal(f.controller.state(owner).token, "second");
});

test("a failed disconnect restore retries after transport recovery and still respects external changes", async () => {
  for (const external of [false, true]) {
    const f = fixture(),
      owner = {};
    f.controller.begin(owner, "focus", { cols: 140, rows: 45 });
    await f.controller.drain();
    const read = f.provider.readSize!;
    f.provider.readSize = async () => {
      throw new Error("temporary outage");
    };
    await f.controller.end(owner);
    assert.equal(f.native.cols, 140);
    f.provider.readSize = read;
    if (external) f.external(103, 37);
    f.controller.poll();
    await f.controller.drain();
    assert.equal(f.native.cols, external ? 103 : 80);
    assert.equal(f.controller.state(owner).active, false);
  }
});

test("a failed initial native read ends the pending focus request without revoking another owner", async () => {
  const f = fixture(),
    first = {},
    second = {};
  f.controller.begin(first, "first", { cols: 140, rows: 45 });
  await f.controller.drain();
  const read = f.provider.readSize!;
  f.provider.readSize = async () => {
    throw new Error("temporary outage");
  };
  f.controller.begin(second, "second", { cols: 160, rows: 50 });
  await f.controller.drain();
  assert.equal(f.controller.state(first).owned, true);
  assert.equal(f.controller.state(second).owned, false);
  assert.equal(f.events.at(-1)?.reason, "unavailable");
  assert.equal(f.errors.length, 1);
  f.provider.readSize = read;
  f.controller.begin(second, "retry", { cols: 160, rows: 50 });
  await f.controller.drain();
  assert.equal(f.controller.state(second).owned, true);
  await f.controller.end(second, "retry");
  assert.equal(f.native.cols, 80);
});

test("a native receipt recovers a lost successful resize response without overwriting an intervening external writer", async () => {
  for (const external of [false, true]) {
    const f = fixture(),
      owner = {};
    const read = f.provider.readSize!,
      resize = f.provider.resize!;
    let available = true;
    let receipt: { before: string; after: string } | undefined;
    f.provider.readSize = async () => {
      if (!available) throw new Error("connection lost");
      const current = await read();
      return {
        ...current,
        ...(receipt?.after === current.token
          ? { recoveredFromToken: receipt.before }
          : {}),
      };
    };
    f.provider.resize = async (cols, rows, expected) => {
      const current = await resize(cols, rows, expected);
      receipt = { before: expected!, after: current.token };
      available = false;
      throw new Error("response lost after native resize");
    };
    f.controller.begin(owner, "focus", { cols: 140, rows: 45 });
    await f.controller.drain();
    assert.equal(f.native.cols, 140);
    assert.equal(f.controller.state(owner).owned, false);
    assert.equal(f.controller.state(owner).active, true);
    if (external) f.external(103, 37);
    available = true;
    await f.controller.end(owner, "focus");
    assert.equal(f.native.cols, external ? 103 : 80);
    assert.equal(f.controller.state(owner).active, false);
  }
});

test("a failed resize before native execution resumes the latest still-requested size after recovery", async () => {
  const f = fixture(),
    owner = {};
  const read = f.provider.readSize!,
    resize = f.provider.resize!;
  let available = true;
  f.provider.readSize = async () => {
    if (!available) throw new Error("connection lost");
    return read();
  };
  f.provider.resize = async () => {
    available = false;
    throw new Error("connection lost before native execution");
  };
  f.controller.begin(owner, "focus", { cols: 140, rows: 45 });
  await f.controller.drain();
  assert.equal(f.native.cols, 80);
  assert.equal(f.controller.state(owner).owned, false);
  available = true;
  f.provider.resize = resize;
  f.controller.poll();
  await f.controller.drain();
  assert.equal(f.native.cols, 140);
  assert.equal(f.controller.state(owner).owned, true);
  await f.controller.end(owner, "focus");
  assert.equal(f.native.cols, 80);
});
