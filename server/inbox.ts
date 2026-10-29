import { spawn } from "node:child_process";
import { sourcePythonCommand } from "./providers.ts";
import type { Source } from "./state.ts";

export interface InboxFile { name: string; size: number }

export function validateInboxFile(value: InboxFile): void {
  if (!value || typeof value.name !== "string" || !value.name ||
      Buffer.byteLength(value.name) > 246 || /[/\\\x00-\x1f\x7f]/u.test(value.name) ||
      value.name === "." || value.name === ".." ||
      Buffer.from(value.name).toString() !== value.name ||
      !Number.isSafeInteger(value.size) || value.size < 0)
    throw new Error("文件名或大小无效");
}

// The same bounded streaming writer runs locally and over the source's SSH
// connection. Only Canvas's private inbox is writable through this protocol.
const inboxPython = String.raw`import json,os,pathlib,re,secrets,signal,stat,sys
os.umask(0o077)
base=pathlib.Path.home()/'.local/share/canvas/inbox'
base.mkdir(parents=True,exist_ok=True,mode=0o700)
info=base.lstat()
if not stat.S_ISDIR(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode&0o077: raise SystemExit('Unsafe inbox')
flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
directory=os.open(base,flags)
def emit(data):
 print(json.dumps(data,ensure_ascii=True),flush=True)
if sys.argv[1]=='remove':
 for value in json.loads(sys.argv[2]):
  p=pathlib.Path(value)
  if p.parent!=base or not re.match(r'^[a-f0-9]{8}_[^/]+$',p.name): raise SystemExit('Invalid inbox path')
  try:
   info=os.stat(p.name,dir_fd=directory,follow_symlinks=False)
   if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid(): raise SystemExit('Unsafe inbox file')
   os.unlink(p.name,dir_fd=directory)
  except FileNotFoundError: pass
 os.close(directory);raise SystemExit(0)
name=sys.argv[2];size=int(sys.argv[3])
if not name or len(name.encode())>246 or re.search(r'[/\\\x00-\x1f\x7f]',name) or name in ('.','..') or size<0: raise SystemExit('Invalid file')
partial='.'+secrets.token_hex(16)+'.part'
fd=os.open(partial,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=directory)
finished=None
def interrupted(*_): raise InterruptedError('Upload cancelled')
signal.signal(signal.SIGTERM,interrupted)
signal.signal(signal.SIGINT,interrupted)
try:
 emit({'ready':True})
 written=0
 with os.fdopen(fd,'wb') as output:
  while written<size:
   chunk=sys.stdin.buffer.read(min(65536,size-written))
   if not chunk: raise IOError('Incomplete upload')
   output.write(chunk);output.flush();written+=len(chunk)
   emit({'received':written})
  if sys.stdin.buffer.read(1): raise IOError('Excess upload bytes')
  output.flush();os.fsync(output.fileno())
 for attempt in range(32):
  candidate=secrets.token_hex(4)+'_'+name
  try:
   os.link(partial,candidate,src_dir_fd=directory,dst_dir_fd=directory,follow_symlinks=False)
   finished=candidate;break
  except FileExistsError: pass
 if finished is None: raise IOError('Could not reserve filename')
 os.unlink(partial,dir_fd=directory);os.fsync(directory)
 emit({'path':str(base/finished)})
except BaseException:
 if finished:
  try: os.unlink(finished,dir_fd=directory)
  except FileNotFoundError: pass
 raise
finally:
 try: os.unlink(partial,dir_fd=directory)
 except FileNotFoundError: pass
 os.close(directory)
`;

export async function writeInboxFile(source: Source, file: InboxFile, bytes: AsyncIterable<Uint8Array>,
  signal: AbortSignal, progress: (received: number) => void): Promise<string> {
  validateInboxFile(file);
  signal.throwIfAborted();
  const command = sourcePythonCommand(source, inboxPython, ["write", file.name, String(file.size)]);
  const child = spawn(command.file, command.args, { env: command.env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "", received = 0, path: string | undefined, settled = false;
  let resolve!: (path: string) => void, reject!: (error: Error) => void;
  const result = new Promise<string>((ok, fail) => { resolve = ok; reject = fail; });
  // Attach immediately: a remote process can fail while the caller reads HTTP.
  void result.catch(() => {});
  let timer: ReturnType<typeof setTimeout>;
  let killing: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    child.stdin.destroy();
    child.kill("SIGTERM");
    if (!killing) { killing = setTimeout(() => child.kill("SIGKILL"), 2000); killing.unref(); }
  };
  const fail = (error: Error) => {
    if (settled) return;
    settled = true; clearTimeout(timer); stop(); reject(error);
  };
  const renew = () => { clearTimeout(timer); timer = setTimeout(() => fail(new Error("上传超时")), 60_000); timer.unref(); };
  const abort = () => fail(new Error("上传已取消"));
  signal.addEventListener("abort", abort, { once: true });
  child.stdin.on("error", () => fail(new Error("上传连接中断")));
  child.on("error", () => fail(new Error("无法连接目标机器")));
  child.stderr.on("data", () => {});
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
    while (output.includes("\n")) {
      const end = output.indexOf("\n"), line = output.slice(0, end); output = output.slice(end + 1);
      if (line.length > 32768) { fail(new Error("无效的上传响应")); return; }
      try {
        const message = JSON.parse(line);
        if (message.ready === true) { if (!settled) renew(); }
        else if (Number.isSafeInteger(message.received) && message.received >= received && message.received <= file.size) {
          received = message.received;
          if (!settled) { renew(); progress(received); }
        } else if (typeof message.path === "string" && message.path.startsWith("/") &&
            !/[\x00-\x1f\x7f]/u.test(message.path) && message.path.endsWith("_" + file.name)) path = message.path;
        else throw new Error();
      } catch { fail(new Error("无效的上传响应")); }
    }
    if (output.length > 32768) fail(new Error("无效的上传响应"));
  });
  child.once("close", code => {
    clearTimeout(timer); clearTimeout(killing); signal.removeEventListener("abort", abort);
    if (settled) {
      // Cancellation can race the durable rename and final stdout message.
      // Reap a reported completed file after the writer has stopped as well.
      if (path) void removeInboxFiles(source, [path]).catch(() => {});
      return;
    }
    settled = true;
    if (code === 0 && path && received === file.size) resolve(path);
    else {
      if (path) void removeInboxFiles(source, [path]).catch(() => {});
      reject(new Error("文件上传失败"));
    }
  });
  renew();
  try {
    const sending = (async () => {
      let sent = 0;
      for await (const chunk of bytes) {
        signal.throwIfAborted();
        if (settled) return await result;
        sent += chunk.byteLength;
        if (sent > file.size) throw new Error("上传大小不符");
        await new Promise<void>((ok, fail) => child.stdin.write(chunk, error => error ? fail(error) : ok()));
      }
      if (sent !== file.size) throw new Error("上传不完整");
      child.stdin.end();
      return await result;
    })();
    return await Promise.race([result, sending]);
  } catch (error) {
    fail(error instanceof Error ? error : new Error("文件上传失败"));
    return await result;
  }
}

export async function removeInboxFiles(source: Source, paths: string[]): Promise<void> {
  if (!paths.length) return;
  const command = sourcePythonCommand(source, inboxPython, ["remove", JSON.stringify(paths)]);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.file, command.args, { env: command.env, stdio: "ignore" });
    const timer = setTimeout(() => { child.kill(); reject(new Error("无法清理取消的上传")); }, 15_000); timer.unref();
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error("无法清理取消的上传")); });
  });
}
