import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AssetStore, sniffFile } from "./assets.ts";
import { createApp } from "./app.ts";
import { Store, type Canvas } from "./state.ts";
import type { TerminalManager } from "./terminals.ts";
import type { Readable } from "node:stream";

async function streamText(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}

async function waitForRemoval(path: string) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (!(await stat(path).catch(() => undefined))) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail("asset bytes were not removed after their last canvas reference");
}

async function fixture(t: TestContext, options: { temporaryTtlMs?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "canvas-assets-"));
  const store = new Store(join(dir, "canvas.db"));
  const assets = new AssetStore(dir, store, options);
  const app = createApp(store, { username: "fixture", passwordHash: "unused" }, {
    closeAll: async () => {}, closeSource: async () => {},
  } as unknown as TerminalManager, { assets });
  store.addSession("test");
  t.after(async () => { await assets.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  const headers = { Host: "localhost", Cookie: "canvas_session=test", "Content-Type": "application/json" };
  const request = (path: string, method = "GET", body?: unknown, authenticated = true) => app.request(`http://localhost${path}`, {
    method,
    headers: authenticated ? headers : { Host: "localhost" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const sourceId = randomUUID(), windowId = "w1";
  const canvas = store.put<Canvas>("canvas", { id: randomUUID(), name: "Files", nodes: [{
    id: "terminal-card", type: "terminal", sourceId, spaceId: "space", windowId, x: 40, y: 60, width: 480, height: 302,
  }] });
  const begin = (filename: string, size: number) => assets.begin({ filename, size });
  const context = (canvasId = canvas.id, anchorId = "terminal-card") => ({ canvasId, anchorId, sourceId, windowId });
  return { dir, store, assets, request, canvas, sourceId, windowId, begin, context };
}

test("file assets stream to private storage and publish metadata with a canvas card", async t => {
  const f = await fixture(t);
  const events = await f.request("/api/events"), reader = events.body!.getReader();
  t.after(() => reader.cancel());
  await reader.read();
  const content = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(3 * 1024 * 1024, 7)]);
  const upload = await f.begin("landscape.png", content.length);
  for (let offset = 0; offset < content.length; offset += 64 * 1024)
    await upload.write(content.subarray(offset, offset + 64 * 1024));
  const { temporary, ...asset } = await upload.complete(f.context());
  assert.equal(temporary, false);
  assert(asset);
  assert.deepEqual({ mime: asset.mime, preview: asset.preview, size: asset.size }, {
    mime: "image/png", preview: "image", size: content.length,
  });
  const view = f.store.canvasView(f.store.get<Canvas>("canvas", f.canvas.id)!);
  const node = view.nodes.find(node => node.type === "file");
  assert(node && node.type === "file");
  assert.equal(node.x, 544);
  assert.equal(node.y, 60);
  assert.equal(node.width, 360);
  assert.equal(node.height, 280);
  assert.deepEqual(node.asset, asset);
  assert.equal(f.store.get<Canvas>("canvas", f.canvas.id)!.nodes.find(node => node.type === "file")?.type, "file");
  const update = new TextDecoder().decode((await reader.read()).value);
  assert.match(update, new RegExp(asset.id));
  assert.match(update, /landscape\.png/u);
  const read = await f.assets.read(asset.id);
  assert(read);
  const chunks: Buffer[] = [];
  for await (const chunk of read.body) chunks.push(Buffer.from(chunk));
  assert.deepEqual(Buffer.concat(chunks), content);
  const stored = await stat(join(f.dir, "files", asset.id));
  assert.equal(stored.mode & 0o777, 0o600);
  const reopened = new Store(join(f.dir, "canvas.db"));
  assert.deepEqual(reopened.canvasView(reopened.get<Canvas>("canvas", f.canvas.id)!).nodes.find(node => node.type === "file") &&
    (reopened.canvasView(reopened.get<Canvas>("canvas", f.canvas.id)!).nodes.find(node => node.type === "file") as typeof node).asset, asset);
  reopened.close();
});

test("MIME sniffing permits safe previews and leaves HTML, SVG and unknown binary opaque", () => {
  assert.deepEqual(sniffFile(Buffer.from("%PDF-1.7")), { mime: "application/pdf", preview: "pdf" });
  assert.deepEqual(sniffFile(Buffer.from("\u0000<svg onload=alert(1) />")), { mime: "application/octet-stream", preview: "file" });
  assert.deepEqual(sniffFile(Buffer.from("<!doctype html><script>bad()</script>")), { mime: "application/octet-stream", preview: "file" });
  assert.deepEqual(sniffFile(Buffer.from("<!-- generated -->\n<html><script>bad()</script>")), { mime: "application/octet-stream", preview: "file" });
  assert.deepEqual(sniffFile(Buffer.from([0, 255, 1, 2])), { mime: "application/octet-stream", preview: "file" });
  assert.deepEqual(sniffFile(Buffer.from("plain text\n")), { mime: "text/plain; charset=utf-8", preview: "text" });
});

test("authenticated file routes stream previews safely and support explicit attachment", async t => {
  const f = await fixture(t), content = Buffer.from("private notes\n");
  const upload = await f.begin("notes.txt", content.length);
  await upload.write(content);
  const { temporary, ...asset } = await upload.complete(f.context());
  assert.equal(temporary, false);
  assert(asset);
  const path = `/api/files/${asset.id}`;
  assert.equal((await f.request(path, "GET", undefined, false)).status, 401);
  const inline = await f.request(path);
  assert.equal(inline.status, 200);
  assert.equal(await inline.text(), content.toString());
  assert.match(inline.headers.get("content-disposition")!, /^inline;/u);
  assert.equal(inline.headers.get("content-security-policy"), "default-src 'none'; sandbox; frame-ancestors 'self'");
  assert.equal(inline.headers.get("x-content-type-options"), "nosniff");
  const attachment = await f.request(`${path}?download=1`);
  assert.match(attachment.headers.get("content-disposition")!, /^attachment;/u);
  assert.equal(await attachment.text(), content.toString());
  const head = await f.request(path, "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(content.length));
  assert.equal(await head.text(), "");
  assert.equal((await f.request(`/api/files/${randomUUID()}`)).status, 404);
});

test("PDF responses allow the native viewer while keeping same-origin embedding", async t => {
  const f = await fixture(t), content = Buffer.from("%PDF-1.7\n%%EOF\n");
  const upload = await f.begin("report.pdf", content.length);
  await upload.write(content);
  const { temporary, ...asset } = await upload.complete(f.context());
  assert.equal(temporary, false);
  assert(asset);
  const response = await f.request(`/api/files/${asset.id}`);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.match(response.headers.get("content-disposition")!, /^inline;/u);
  assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'self'");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), content);
});

test("file nodes cannot refer to missing or another canvas's asset", async t => {
  const f = await fixture(t), other = f.store.put<Canvas>("canvas", { id: randomUUID(), name: "Other", nodes: [] });
  const upload = await f.begin("report.txt", 3);
  await upload.write(Buffer.from("abc"));
  const { temporary, ...asset } = await upload.complete(f.context());
  assert.equal(temporary, false);
  assert(asset);
  assert.throws(() => f.store.put("canvas", { ...other, nodes: [{
    id: "foreign", type: "file", assetId: asset.id, x: 0, y: 0, width: 320, height: 160,
  }] }), /File asset not found in this canvas/u);
  assert.throws(() => f.store.put("canvas", { ...other, nodes: [{
    id: "missing", type: "file", assetId: randomUUID(), x: 0, y: 0, width: 320, height: 160,
  }] }), /File asset not found in this canvas/u);
  const noAnchor = await f.begin("discard.txt", 1);
  await noAnchor.write(Buffer.from("x"));
  await assert.rejects(noAnchor.complete(f.context(f.canvas.id, "not-an-anchor")), /destination no longer exists/u);
  assert.deepEqual(await readdir(join(f.dir, "files")), [asset.id]);
});

test("deleting one card keeps its shared canvas asset until the last reference is removed", async t => {
  const f = await fixture(t), upload = await f.begin("shared.txt", 3);
  await upload.write(Buffer.from("abc"));
  const { temporary, ...asset } = await upload.complete(f.context());
  assert.equal(temporary, false);
  assert(asset);
  const canvas = f.store.get<Canvas>("canvas", f.canvas.id)!;
  const firstFile = canvas.nodes.find(node => node.type === "file")!;
  const duplicated = f.store.put("canvas", { ...canvas, nodes: [...canvas.nodes, {
    id: "second-card", type: "file", assetId: asset.id, x: 900, y: 0, width: 320, height: 160,
  }] });
  const file = join(f.dir, "files", asset.id);
  f.store.put("canvas", { ...duplicated, nodes: duplicated.nodes.filter(node => node.id !== firstFile.id) });
  await new Promise(resolve => setImmediate(resolve));
  assert(f.store.fileAsset(asset.id), "another card still references this file");
  assert.equal(await readFile(file, "utf8"), "abc");
  f.store.put("canvas", { ...f.store.get<Canvas>("canvas", f.canvas.id)!, nodes: [] });
  await waitForRemoval(file);
  await assert.rejects(readFile(file));
  f.store.remove("canvas", f.canvas.id);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(readFile(file));
  assert.equal(f.store.fileAsset(asset.id), undefined);
});

test("abandoned and overlong uploads do not retain partial files", async t => {
  const f = await fixture(t), upload = await f.begin("partial.bin", 8);
  await upload.write(Buffer.from("four"));
  await assert.rejects(upload.complete(f.context()), /ended before declared length/u);
  await upload.abort();
  const excess = await f.begin("excess.bin", 1);
  await assert.rejects(excess.write(Buffer.from("too much")), /exceeded declared length/u);
  await excess.abort();
  const large = await f.begin("large.bin", 5 * 1024 * 1024 * 1024);
  await large.abort();
  assert.deepEqual(await readdir(join(f.dir, "tmp")), ["staged"]);
  assert.deepEqual(await readdir(join(f.dir, "files")), []);
});

test("aborting while completion is awaiting disk sync leaves neither a file nor a card", async t => {
  const f = await fixture(t), upload = await f.begin("cancelled.txt", 4);
  await upload.write(Buffer.from("test"));
  const complete = upload.complete(f.context());
  const failed = assert.rejects(complete, /Upload is closed|closed|file descriptor/iu);
  await upload.abort();
  await failed;
  assert.deepEqual(f.store.fileAssetIds(), []);
  assert(!f.store.get<Canvas>("canvas", f.canvas.id)!.nodes.some(node => node.type === "file"));
  assert.deepEqual(await readdir(join(f.dir, "tmp")), ["staged"]);
  assert.deepEqual(await readdir(join(f.dir, "files")), []);
});

test("overview uploads stage complete bytes while a removed custom canvas fails without retaining them", async t => {
  const f = await fixture(t);
  const overview = await f.begin("overview.txt", 3);
  await overview.write(Buffer.from("abc"));
  const staged = await overview.complete(f.context("overview"));
  assert.equal(staged.temporary, true);
  assert.equal(await f.assets.read(staged.id), undefined, "staged files are not public persistent assets");
  const first = await f.assets.readTemporary(staged.id);
  assert(first);
  assert.equal(await streamText(first.body), "abc");
  const again = await f.assets.readTemporary(staged.id);
  assert(again, "native download can retry the same staged bytes until expiry");
  assert.equal(await streamText(again.body), "abc");
  const deleted = await f.begin("removed.txt", 3);
  await deleted.write(Buffer.from("abc"));
  f.store.remove("canvas", f.canvas.id);
  await assert.rejects(deleted.complete(f.context()), /destination no longer exists/u);
  assert.deepEqual(f.store.fileAssetIds(), []);
  assert.equal(f.store.get("canvas", f.canvas.id), undefined);
  assert.deepEqual(await readdir(join(f.dir, "tmp")), ["staged"]);
  assert.deepEqual(await readdir(join(f.dir, "files")), []);
  await f.assets.discardTemporary(staged.id);
  assert.equal(await f.assets.readTemporary(staged.id), undefined);
  assert.deepEqual(await readdir(join(f.dir, "tmp", "staged")), []);
});

test("temporary uploads expire without interrupting a reader or deleting persistent files", async t => {
  const f = await fixture(t, { temporaryTtlMs: 60 });
  const permanent = await f.begin("saved.txt", 4);
  await permanent.write(Buffer.from("kept"));
  const asset = await permanent.complete(f.context());
  const upload = await f.begin("temporary.txt", 6);
  await upload.write(Buffer.from("staged"));
  const staged = await upload.complete(f.context("overview"));
  const read = await f.assets.readTemporary(staged.id);
  assert(read);
  await waitForRemoval(join(f.dir, "tmp", "staged", staged.id));
  assert.equal(await f.assets.readTemporary(staged.id), undefined);
  assert.equal(await streamText(read.body), "staged", "an already opened file remains readable after expiry unlinks its name");
  assert.equal(await readFile(join(f.dir, "files", asset.id), "utf8"), "kept");
});

test("restart recovery removes only generated staged uploads and preserves committed assets", async t => {
  const f = await fixture(t), upload = await f.begin("saved.txt", 4);
  await upload.write(Buffer.from("kept"));
  const asset = await upload.complete(f.context());
  const stale = randomUUID(), partial = `${randomUUID()}.part`;
  await writeFile(join(f.dir, "tmp", "staged", stale), "stale", { mode: 0o600 });
  await writeFile(join(f.dir, "tmp", "staged", "unmanaged.txt"), "unmanaged", { mode: 0o600 });
  await writeFile(join(f.dir, "tmp", partial), "partial", { mode: 0o600 });
  const restarted = new AssetStore(f.dir, f.store);
  try {
    const saved = await restarted.read(asset.id);
    assert(saved);
    assert.equal(await streamText(saved.body), "kept");
    assert.deepEqual(await readdir(join(f.dir, "tmp", "staged")), ["unmanaged.txt"]);
    assert.deepEqual(await readdir(join(f.dir, "tmp")), ["staged"]);
    assert.equal(await restarted.readTemporary(stale), undefined);
  } finally { await restarted.close(); }
});

test("closing asset storage removes staged uploads without deleting persistent assets", async t => {
  const f = await fixture(t), saved = await f.begin("saved.txt", 4);
  await saved.write(Buffer.from("kept"));
  const permanent = await saved.complete(f.context());
  const upload = await f.begin("temporary.txt", 4);
  await upload.write(Buffer.from("temp"));
  const temporary = await upload.complete(f.context("overview"));
  await f.assets.close();
  assert.equal(await f.assets.readTemporary(temporary.id), undefined);
  assert.deepEqual(await readdir(join(f.dir, "tmp", "staged")), []);
  assert.equal(await readFile(join(f.dir, "files", permanent.id), "utf8"), "kept");
});

test("JavaScript and HTML extensions remain attachments even when their bytes are plain text", async t => {
  const f = await fixture(t);
  for (const extension of ["html", "svg", "js", "mjs", "cjs"]) {
    const upload = await f.begin(`sample.${extension}`, 3);
    await upload.write(Buffer.from("abc"));
    const { temporary, ...asset } = await upload.complete(f.context());
    assert.equal(temporary, false);
    assert(asset);
    assert.equal(asset.preview, "file");
    assert.equal(asset.mime, "application/octet-stream");
    const response = await f.request(`/api/files/${asset.id}`);
    assert.match(response.headers.get("content-disposition")!, /^attachment;/u);
    assert.equal(await response.text(), "abc");
  }
});
