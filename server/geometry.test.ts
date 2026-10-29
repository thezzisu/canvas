import test from "node:test";
import assert from "node:assert/strict";
import { GeometryController, type Size } from "./geometry.ts";

function fixture() {
  const writes: Size[] = [];
  const errors: unknown[] = [];
  const events: unknown[] = [];
  const controller = new GeometryController<object>(
    { cols: 80, rows: 24 },
    size => { writes.push(size); },
    reason => { events.push(reason); },
    error => { errors.push(error); },
  );
  return { controller, writes, errors, events };
}

test("maximize takeover retains the original viewport and ignores the former owner", async () => {
  const f = fixture(), a = {}, b = {};
  f.controller.begin(a, "first", { cols: 140, rows: 45 });
  await f.controller.drain();
  f.controller.begin(b, "second", { cols: 160, rows: 50 });
  await f.controller.drain();
  assert.equal(f.controller.state(a).owned, false);
  assert.equal(f.controller.state(b).owned, true);
  f.controller.update(a, "first", { cols: 90, rows: 30 });
  await f.controller.end(a, "first");
  assert.deepEqual(f.controller.current, { cols: 160, rows: 50 });
  await f.controller.end(b, "second");
  assert.deepEqual(f.controller.current, { cols: 80, rows: 24 });
  assert.equal(f.controller.state(b).active, false);
});

test("immediate cancellation performs no resize, disconnect and shutdown restore", async () => {
  const f = fixture(), owner = {};
  f.controller.begin(owner, "cancel", { cols: 140, rows: 45 });
  await f.controller.end(owner, "cancel");
  assert.equal(f.writes.length, 0);
  f.controller.begin(owner, "live", { cols: 140, rows: 45 });
  await f.controller.drain();
  await f.controller.end(owner);
  assert.deepEqual(f.controller.current, { cols: 80, rows: 24 });
  f.controller.begin(owner, "shutdown", { cols: 140, rows: 45 });
  await f.controller.drain();
  await f.controller.close();
  assert.deepEqual(f.controller.current, { cols: 80, rows: 24 });
  f.controller.begin(owner, "ignored", { cols: 120, rows: 40 });
  f.controller.persistent({ cols: 120, rows: 40 });
  await f.controller.drain();
  assert.equal(f.controller.state(owner).active, false);
  assert.deepEqual(f.controller.current, { cols: 80, rows: 24 });
});

test("viewport and card resize bursts keep only the latest queued size", async () => {
  const f = fixture(), owner = {};
  f.controller.begin(owner, "focus", { cols: 140, rows: 45 });
  await f.controller.drain();
  for (let cols = 141; cols <= 180; cols++)
    f.controller.update(owner, "focus", { cols, rows: 50 });
  await f.controller.drain();
  assert.deepEqual(f.controller.current, { cols: 180, rows: 50 });
  assert.equal(f.writes.length, 2);
  await f.controller.end(owner, "focus");
  for (let cols = 81; cols <= 120; cols++)
    f.controller.persistent({ cols, rows: 30 });
  await f.controller.drain();
  assert.deepEqual(f.controller.current, { cols: 120, rows: 30 });
  assert.equal(f.writes.length, 4);
  f.controller.persistent({ cols: 120, rows: 30 });
  await f.controller.drain();
  assert.equal(f.writes.length, 4, "unchanged viewports do not redraw the shell");
});

test("pending updates from an old focus cannot consume the next focus's viewport", async () => {
  const f = fixture(), owner = {};
  f.controller.begin(owner, "first", { cols: 140, rows: 45 });
  await f.controller.drain();
  f.controller.update(owner, "first", { cols: 150, rows: 45 });
  const ended = f.controller.end(owner, "first");
  f.controller.begin(owner, "second", { cols: 160, rows: 50 });
  f.controller.update(owner, "second", { cols: 170, rows: 55 });
  await ended;
  await f.controller.drain();
  assert.deepEqual(f.controller.current, { cols: 170, rows: 55 });
  assert.equal(f.controller.state(owner).token, "second");
  await f.controller.end(owner, "first");
  assert.equal(f.controller.state(owner).token, "second");
  await f.controller.end(owner, "second");
  assert.deepEqual(f.controller.current, { cols: 80, rows: 24 });
});

test("a card resize during maximization updates the restore viewport without interrupting the owner", async () => {
  const f = fixture(), owner = {}, other = {};
  f.controller.begin(owner, "focus", { cols: 140, rows: 45 });
  await f.controller.drain();
  f.controller.persistent({ cols: 100, rows: 32 });
  await f.controller.drain();
  assert.deepEqual(f.controller.current, { cols: 140, rows: 45 });
  assert.equal(f.controller.state(owner).owned, true);
  f.controller.begin(other, "takeover", { cols: 160, rows: 50 });
  await f.controller.drain();
  await f.controller.end(other, "takeover");
  assert.deepEqual(f.controller.current, { cols: 100, rows: 32 });
});

test("closed transports do not leave shutdown or the resize queue hanging", async () => {
  let closed = false;
  const errors: unknown[] = [];
  const controller = new GeometryController<object>(
    { cols: 80, rows: 24 },
    () => { if (closed) throw new Error("closed transport"); },
    () => {}, error => { errors.push(error); },
  );
  const owner = {};
  controller.begin(owner, "live", { cols: 140, rows: 45 });
  await controller.drain();
  closed = true;
  await controller.close();
  assert.equal(errors.length, 1);
  assert.equal(controller.state(owner).active, false);
});
