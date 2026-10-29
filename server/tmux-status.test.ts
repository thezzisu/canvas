import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pty from "node-pty";
import { ProgramStatusStream, parseProgramStatus } from "./tmux-status.ts";
import {
  closeStatusObservers,
  listResources,
  openTerminal,
  shellQuote,
  type Source,
} from "./providers.ts";

const report = (body: string, end = "\x07") =>
  Buffer.from(`\x1b]7501;${body}${end}`);

test("OSC7501 validates complete reports before mutation", () => {
  assert.deepEqual(
    parseProgramStatus("state=working:progress=007:id=build/test"),
    { state: "working", progress: 7, id: "build/test" },
  );
  assert.deepEqual(
    parseProgramStatus("unknown=yes:bad:state=working:state=done"),
    { state: "done" },
  );
  assert.deepEqual(parseProgramStatus(" state = idle : app = a/b "), {
    state: "idle",
  });
  assert.deepEqual(parseProgramStatus("state=working:progress=999"), {
    state: "working",
  });
  for (const body of [
    "?",
    "state=future",
    "app=cargo",
    "state=clear:id=",
    "state=clear:id=a@b",
    "state=clear:id=a//b:id=ok",
    `state=idle:app=${"x".repeat(33)}:app=ok`,
    `state=idle:${"x".repeat(17)}=x`,
    "state=done:msg=QQ=",
    "state=done:msg=YQpi",
    "state=done:title=wps=",
    "state=done:msg=/w==",
    "state=done:msg=a",
  ]) {
    assert.equal(parseProgramStatus(body), undefined, body);
  }
  assert.deepEqual(parseProgramStatus("state=done:msg=5a6J5YWo"), {
    state: "done",
  });
});

test("OSC7501 keeps pane records, handles fragmentation, clearing, shell lifetime and reset", () => {
  const stream = new ProgramStatusStream();
  const bytes = Buffer.concat([
    report("state=idle:app=fixture"),
    report("state=blocked:id=child:progress=17", "\x1b\\"),
  ]);
  for (const byte of bytes) stream.feed(Buffer.from([byte]));
  assert.equal(stream.snapshot()!.status, "attention");
  assert.equal(stream.snapshot()!.progress, 17);
  stream.feed(report("state=clear:id=bad@id"));
  assert.equal(stream.snapshot()!.status, "attention");
  stream.feed(report("state=clear:id=child"));
  assert.equal(stream.snapshot()!.status, "idle");
  stream.feed(report("state=working:id=child/grandchild"));
  stream.feed(report("state=clear:id=child"));
  assert.equal(stream.snapshot()!.status, "idle");
  stream.feed(report("state=working:id=job"));
  stream.feed(report("state=done:id=other"));
  stream.feed(Buffer.from("\x1b]133;A;aid=1\x07"));
  assert.equal(stream.snapshot()!.status, "done");
  stream.feed(report("state=error:id=other"));
  stream.processExited();
  assert.equal(stream.snapshot()!.status, "error");
  stream.feed(report("state=clear"));
  assert.equal(stream.snapshot()!.status, "unknown");
  assert.equal(stream.snapshot()!.statusSource, "osc7501");
  stream.feed(Buffer.from("\x1b"));
  stream.feed(Buffer.from("c"));
  assert.equal(stream.snapshot(), undefined);
  stream.feed(report("?"));
  assert.equal(stream.snapshot(), undefined);
  stream.feed(
    Buffer.from(`\x1bPignored${report("state=error").toString()}\x1b\\`),
  );
  assert.equal(stream.snapshot(), undefined, "do not interpret OSC inside DCS");
  stream.feed(Buffer.from(`\x1b]7501;state=error:${"x".repeat(9000)}\x07`));
  assert.equal(
    stream.snapshot(),
    undefined,
    "oversized report does not change state",
  );
  stream.feed(report("state=idle"));
  assert.equal(
    stream.snapshot()!.status,
    "idle",
    "parser recovers after oversize",
  );
  stream.feed(Buffer.from("\x1b]7501;state=error\x18\x07"));
  assert.equal(stream.snapshot()!.status, "idle", "CAN cancels the report");
  stream.feed(report("state=error:id=old"));
  for (let i = 0; i < 256; i++) stream.feed(report(`state=idle:id=record${i}`));
  assert.equal(
    stream.snapshot()!.status,
    "idle",
    "record limit evicts least recently updated entry",
  );
});

test("tmux OSC7501 helper observer preserves native selections, dimensions and pane input", async (t) => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
  } catch {
    t.skip("tmux is not installed");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "canvas-osc7501-"));
  const socket = join(root, "socket");
  const events = join(root, "events");
  const script = join(root, "fixture.py");
  writeFileSync(events, "");
  writeFileSync(
    script,
    `import sys,os,signal,tty\nf=open(sys.argv[1],'a',buffering=1)\nsignal.signal(signal.SIGWINCH,lambda *_: f.write('resize\\n'))\ntty.setraw(0)\nwhile True:\n data=os.read(0,4096)\n if not data: break\n f.write(data.hex()+'\\n')\n os.write(1,data)\n`,
  );
  const tmux = (...args: string[]) =>
    execFileSync("tmux", ["-S", socket, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trimEnd();
  const source: Source = {
    id: "osc7501",
    name: "OSC7501",
    type: "tmux",
    transport: "local",
    tmuxSocket: socket,
  };
  let client: pty.IPty | undefined;
  let bare: pty.IPty | undefined;
  let opened: Awaited<ReturnType<typeof openTerminal>> | undefined;
  const wait = async (
    predicate: () => boolean | Promise<boolean>,
    message: string,
  ) => {
    for (let i = 0; i < 100; i++) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(message);
  };
  try {
    const command = ["python3", script, events].map(shellQuote).join(" ");
    tmux(
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      "first",
      "-n",
      "main",
      "-x",
      "100",
      "-y",
      "30",
      command,
    );
    tmux("split-window", "-h", "-t", "first:0", command);
    tmux("new-window", "-t", "first:", "-n", "other", "/bin/sh");
    tmux("new-session", "-d", "-s", "second", "/bin/sh");
    tmux("link-window", "-s", "first:0", "-t", "second:1");
    client = pty.spawn(
      "tmux",
      ["-S", socket, "attach-session", "-t", "first"],
      {
        cols: 100,
        rows: 30,
        name: "xterm-256color",
        env: { PATH: process.env.PATH!, HOME: root, TERM: "xterm-256color" },
      },
    );
    client.onData(() => {});
    await wait(
      () => tmux("list-clients", "-F", "#{client_control_mode}").includes("0"),
      "ordinary native client did not attach",
    );
    const resources = await listResources(source);
    const sourceSpace = resources.spaces.find((s) => s.name === "first")!;
    const sourceWindow = sourceSpace.windows.find((w) => w.name === "main")!;
    assert.equal(
      tmux("list-clients", "-F", "#{client_control_mode}"),
      "0",
      "resource discovery attached an observer",
    );
    opened = await openTerminal(
      source,
      sourceSpace.id,
      sourceWindow.id,
      100,
      30,
    );
    assert.ok(!opened.connect);
    bare = pty.spawn(opened.file, opened.args, {
      cols: 100,
      rows: 30,
      name: "xterm-256color",
      env: {
        PATH: process.env.PATH!,
        HOME: root,
        TERM: "xterm-256color",
        ...opened.env,
      },
    });
    let ready = false;
    bare.onData(() => {
      ready = true;
    });
    await wait(() => ready, "bare native client did not attach");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const beforeEvents = readFileSync(events, "utf8");
    const beforePipes = tmux(
      "list-panes",
      "-a",
      "-F",
      "#{pane_id}:#{pane_pipe}",
    );
    const beforeDimensions = tmux(
      "list-windows",
      "-a",
      "-F",
      "#{window_id}:#{window_width}x#{window_height}",
    );
    const beforeSelection = tmux(
      "list-sessions",
      "-F",
      "#{session_id}:#{window_id}",
    );
    const read = async () =>
      (await listResources(source)).spaces
        .find((s) => s.name === "first")!
        .windows.find((w) => w.name === "main")!;
    opened.connected!();
    await wait(
      () =>
        tmux("list-clients", "-F", "#{client_control_mode}")
          .split("\n")
          .filter((x) => x === "1").length === 1,
      "helper observer did not attach",
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(
      readFileSync(events, "utf8"),
      beforeEvents,
      "observer attachment delivered SIGWINCH or input",
    );
    const emit = (pane: string, body: string, end = "\x07") =>
      tmux(
        "send-keys",
        "-H",
        "-t",
        pane,
        ...Array.from(report(body, end)).map((byte) => byte.toString(16)),
      );
    emit("first:0.0", "state=working:progress=25");
    emit("first:0.1", "state=blocked:id=worker:kind=permission");
    await wait(async () => {
      const window = await read();
      return (
        window.status === "attention" &&
        window.panes.some((p) => p.progress === 25)
      );
    }, "pane reports not attributed");
    const linked = (await listResources(source)).spaces
      .find((s) => s.name === "second")!
      .windows.find((w) => w.name === "main")!;
    assert.equal(linked.status, "attention");
    emit("first:0.1", "state=clear:id=worker", "\x1b\\");
    await wait(
      async () => (await read()).status === "working",
      "subtree clear not reflected",
    );
    const inputBefore = readFileSync(events, "utf8");
    emit("first:0.0", "?");
    await wait(
      () => readFileSync(events, "utf8") !== inputBefore,
      "fixture did not receive query",
    );
    const afterQuery = readFileSync(events, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(
      readFileSync(events, "utf8"),
      afterQuery,
      "passive observer injected capability reply",
    );
    assert.equal(
      tmux("list-panes", "-a", "-F", "#{pane_id}:#{pane_pipe}"),
      beforePipes,
    );
    assert.equal(
      tmux(
        "list-windows",
        "-a",
        "-F",
        "#{window_id}:#{window_width}x#{window_height}",
      ),
      beforeDimensions,
    );
    assert.equal(
      tmux("list-sessions", "-F", "#{session_id}:#{window_id}"),
      beforeSelection,
    );
    const beforeCleanup = readFileSync(events, "utf8");
    const sessionsBeforeCleanup = tmux("list-sessions", "-F", "#{session_id}");
    closeStatusObservers();
    await wait(
      () =>
        !tmux("list-clients", "-F", "#{client_control_mode}")
          .split("\n")
          .includes("1"),
      "observer cleanup left control clients attached",
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(
      readFileSync(events, "utf8"),
      beforeCleanup,
      "observer cleanup changed dimensions or input",
    );
    assert.equal(
      tmux("list-sessions", "-F", "#{session_id}"),
      sessionsBeforeCleanup,
      "observer detach removed a native helper session",
    );
    assert.equal(
      tmux("list-clients", "-F", "#{client_control_mode}")
        .split("\n")
        .filter((x) => x === "0").length,
      2,
      "observer detach disconnected a native client",
    );
  } finally {
    closeStatusObservers();
    bare?.kill();
    await opened?.cleanup();
    client?.kill();
    try {
      tmux("kill-server");
    } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});
