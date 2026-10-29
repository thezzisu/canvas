import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function runIsolated(t: TestContext, body: string, completedRace?: "reported" | "late") {
  const root = await mkdtemp(join(tmpdir(), "canvas-inbox-test-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  // Redirect only this Python process's Path.home(). The test runner's HOME,
  // user configuration and concurrent test processes are never modified.
  const wrapper = join(bin, "python3");
  await writeFile(wrapper, `#!/usr/bin/python3
import pathlib,sys,json
test_root=pathlib.Path(__file__).parent.parent/'inbox-home'
pathlib.Path.home=classmethod(lambda cls:test_root)
assert sys.argv[1]=='-c'
script=sys.argv[2]
sys.argv=['-c',*sys.argv[3:]]
race=${JSON.stringify(completedRace ?? "")}
if race:
 marker=json.dumps(str(test_root.parent/'completed-race-ready'))
 if race=='reported':
  replacement=" signal.signal(signal.SIGTERM,lambda *_:os._exit(0))\\n emit({'path':str(base/finished)})\\n pathlib.Path("+marker+").write_text('ready')\\n __import__('time').sleep(5)\\n os._exit(0)"
 else:
  replacement=" def stopped_after_commit(*_):\\n  emit({'path':str(base/finished)})\\n  os._exit(0)\\n signal.signal(signal.SIGTERM,stopped_after_commit)\\n pathlib.Path("+marker+").write_text('ready')\\n __import__('time').sleep(5)\\n emit({'path':str(base/finished)})"
 script=script.replace(" emit({'path':str(base/finished)})",replacement)
exec(compile(script,'<canvas-inbox-fixture>','exec'),{'__name__':'__main__'})
`);
  await chmod(wrapper, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = `
import assert from 'node:assert/strict';
import { readFile, readdir, stat, mkdir, writeFile, symlink } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeInboxFile, removeInboxFiles, validateInboxFile } from './server/inbox.ts';
const root = process.env.CANVAS_INBOX_TEST_ROOT;
const inbox = join(root, 'inbox-home', '.local/share/canvas/inbox');
const source = { id: 'fixture', name: 'Fixture', type: 'tmux', transport: 'local' };
async function* chunks(bytes, size = 17003) { for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size); }
async function waitFor(check) { for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('cleanup did not finish'); }
${body}
`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: sourceRoot,
      env: { PATH: `${bin}:${process.env.PATH || "/usr/bin:/bin"}`, LANG: "C.UTF-8", CANVAS_INBOX_TEST_ROOT: root },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", chunk => output += chunk);
    child.stderr.on("data", chunk => output += chunk);
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("inbox fixture timed out")); }, 10_000);
    child.once("error", reject);
    child.once("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(output || `inbox fixture exited ${code}`)); });
  });
}

test("real inbox writes preserve quoted Unicode names, arbitrary bytes and private permissions", async t => {
  await runIsolated(t, `
const name = "原始 O'Brian (final).bin", bytes = randomBytes(300000);
const progress = [];
const path = await writeInboxFile(source, { name, size: bytes.length }, chunks(bytes), new AbortController().signal, received => {
  let observed = false;
  for (let attempt = 0; attempt < 2 && !observed; attempt++) {
    const candidates = readdirSync(inbox).filter(entry => entry.endsWith('.part') ||
      (/^[a-f0-9]{8}_/.test(entry) && entry.slice(9) === name));
    for (const entry of candidates) {
      let info;
      try { info = statSync(join(inbox, entry)); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      assert(info.isFile() && info.size >= received, 'reported progress must already be written to disk');
      observed = true;
      break;
    }
    // The writer links the completed name before removing .part. If that
    // removal raced stat(), a fresh listing must find the committed file.
  }
  assert(observed, 'progress requires an existing partial or committed file');
  progress.push(received);
});
assert.match(basename(path), /^[a-f0-9]{8}_/);
assert.equal(basename(path).slice(9), name);
assert.equal(dirname(path), inbox);
assert.deepEqual(await readFile(path), bytes);
assert.equal((await stat(path)).mode & 0o777, 0o600);
assert.equal((await stat(inbox)).mode & 0o777, 0o700);
assert.equal(progress.at(-1), bytes.length);
assert(progress.every((value, i) => i === 0 || value > progress[i - 1]));
assert.equal((await readdir(inbox)).some(name => name.endsWith('.part')), false);
await removeInboxFiles(source, [path]);
assert.deepEqual(await readdir(inbox), []);
`);
});

test("real inbox handles empty files and independently prefixes duplicate original names", async t => {
  await runIsolated(t, `
const paths = [];
for (const content of [Buffer.alloc(0), Buffer.from('first'), Buffer.from('second')]) {
  const path = await writeInboxFile(source, { name: 'same.txt', size: content.length }, chunks(content), new AbortController().signal, () => {});
  paths.push(path);
  assert.deepEqual(await readFile(path), content);
}
assert.equal(new Set(paths).size, 3);
await removeInboxFiles(source, paths);
await removeInboxFiles(source, paths);
assert.deepEqual(await readdir(inbox), []);
`);
});

test("real inbox rejects short and oversized streams and removes partial bytes", async t => {
  await runIsolated(t, `
for (const [declared, bytes] of [[10, Buffer.from('short')], [1, Buffer.from('oversized')]]) {
  await assert.rejects(writeInboxFile(source, { name: 'bad.bin', size: declared }, chunks(bytes), new AbortController().signal, () => {}));
  await waitFor(async () => !(await readdir(inbox).catch(() => [])).some(name => name.endsWith('.part')));
  assert.deepEqual(await readdir(inbox).catch(() => []), []);
}
`);
});

test("real inbox cancellation interrupts a blocked upload and removes its partial file", async t => {
  await runIsolated(t, `
const controller = new AbortController();
async function* blocked() { yield Buffer.alloc(65536, 7); await new Promise(() => {}); }
await assert.rejects(writeInboxFile(source, { name: 'cancel.bin', size: 131072 }, blocked(), controller.signal, () => controller.abort()), /取消/);
await waitFor(async () => (await readdir(inbox)).length === 0);
assert.deepEqual(await readdir(inbox), []);
const already = new AbortController(); already.abort();
await assert.rejects(writeInboxFile(source, { name: 'never.bin', size: 0 }, chunks(Buffer.alloc(0)), already.signal, () => {}));
assert.deepEqual(await readdir(inbox), []);
`);
});

test("inbox validation and cleanup cannot target paths outside its private directory", async t => {
  await runIsolated(t, `
for (const name of ['', '../escape', 'part/name', 'part\\\\name', '.', '..', 'line\\nname', 'x'.repeat(247)])
  assert.throws(() => validateInboxFile({ name, size: 0 }));
for (const size of [-1, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => validateInboxFile({ name: 'file', size }));
const empty = await writeInboxFile(source, { name: 'keep.txt', size: 0 }, chunks(Buffer.alloc(0)), new AbortController().signal, () => {});
const outside = join(root, 'outside.txt'); await writeFile(outside, 'untouched');
await assert.rejects(removeInboxFiles(source, [outside]));
assert.equal(await readFile(outside, 'utf8'), 'untouched');
const link = join(inbox, 'deadbeef_link.txt'); await symlink(outside, link);
await assert.rejects(removeInboxFiles(source, [link]));
assert.equal(await readFile(outside, 'utf8'), 'untouched');
assert.equal((await stat(empty)).size, 0);
`);
});

test("cancellation reaps a durably written file whose path arrives before or after abort", async t => {
  for (const timing of ["reported", "late"] as const) {
    await t.test(timing, async t => {
      await runIsolated(t, `
const controller = new AbortController(), progress = [];
const operation = writeInboxFile(source, { name: 'committed.bin', size: 4 }, chunks(Buffer.from('done')), controller.signal, bytes => progress.push(bytes));
const rejected = assert.rejects(operation, /取消/);
await waitFor(async () => !!(await stat(join(root, 'completed-race-ready')).catch(() => undefined)));
const committed = (await readdir(inbox)).filter(name => !name.endsWith('.part'));
assert.equal(committed.length, 1, 'fixture reached durable commit before abort');
assert.equal(await readFile(join(inbox, committed[0]), 'utf8'), 'done');
const progressBeforeAbort = [...progress];
controller.abort();
await rejected;
await waitFor(async () => (await readdir(inbox)).length === 0);
assert.deepEqual(progress, progressBeforeAbort, 'late protocol data must not restart progress');
assert.deepEqual(await readdir(inbox), []);
`, timing);
    });
  }
});
