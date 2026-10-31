import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";

export interface HerdrLocation { herdrSocket?: string; herdrSession?: string }
export interface HerdrSockets { api: string; client: string }

export function validateHerdrLocation(location: HerdrLocation): void {
  if (location.herdrSocket !== undefined &&
      (!location.herdrSocket.startsWith("/") || location.herdrSocket.length > 1000 || /[:\x00-\x1f\x7f]/u.test(location.herdrSocket)))
    throw new Error("Herdr socket must be an absolute Unix socket path");
  if (location.herdrSession !== undefined &&
      (!/^[a-zA-Z0-9_.-]{1,64}$/u.test(location.herdrSession) || location.herdrSession === "." || location.herdrSession === ".."))
    throw new Error("Invalid herdr session name");
}

export function herdrSocketPaths(location: HerdrLocation, environment: NodeJS.ProcessEnv = process.env): HerdrSockets {
  validateHerdrLocation(location);
  const session = location.herdrSession || "default";
  const root = environment.XDG_CONFIG_HOME !== undefined ? join(environment.XDG_CONFIG_HOME, "herdr")
    : environment.HOME !== undefined ? join(environment.HOME, ".config", "herdr") : join(tmpdir(), "herdr");
  const api = location.herdrSocket || join(root, ...(session === "default" ? [] : ["sessions", session]), "herdr.sock");
  const stem = parse(api).name;
  const client = join(dirname(api), `${stem}-client.sock`);
  if (!api.startsWith("/") || !client.startsWith("/")) throw new Error("Herdr configuration directory must be absolute");
  return { api, client };
}

export async function localHerdrSockets(location: HerdrLocation): Promise<HerdrSockets> {
  const paths = herdrSocketPaths(location);
  const [api, client] = await Promise.all([realpath(paths.api), realpath(paths.client)]);
  if (!(await stat(api)).isSocket() || !(await stat(client)).isSocket()) throw new Error("Herdr endpoint is not a Unix socket");
  return { api, client };
}

// Resolve only the selected session on the destination. No CLI, startup files,
// environment dump, directory scan or server mutation is involved.
export const discoverHerdrPython = String.raw`import json,os,pathlib,stat,sys,tempfile
location=json.loads(sys.argv[1]);session=location.get('herdrSession') or 'default'
root=pathlib.Path(os.environ['XDG_CONFIG_HOME'])/'herdr' if 'XDG_CONFIG_HOME' in os.environ else pathlib.Path(os.environ['HOME'])/'.config/herdr' if 'HOME' in os.environ else pathlib.Path(tempfile.gettempdir())/'herdr'
api=pathlib.Path(location['herdrSocket']) if location.get('herdrSocket') else root/'herdr.sock' if session=='default' else root/'sessions'/session/'herdr.sock'
client=api.with_name(api.stem+'-client.sock')
result={}
for key,path in [('api',api),('client',client)]:
 if not path.is_absolute(): raise SystemExit('Herdr configuration directory must be absolute')
 path=path.resolve(strict=True)
 if not stat.S_ISSOCK(path.stat().st_mode): raise SystemExit('Herdr endpoint is not a Unix socket')
 result[key]=str(path)
print(json.dumps(result))`;

export function parseHerdrSockets(text: string): HerdrSockets {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Invalid herdr socket discovery response"); }
  if (!value || typeof value !== "object") throw new Error("Invalid herdr socket discovery response");
  const paths = value as Record<string, unknown>;
  for (const key of ["api", "client"])
    if (typeof paths[key] !== "string" || !(paths[key] as string).startsWith("/") || (paths[key] as string).length > 1000 || /[:\x00-\x1f\x7f]/u.test(paths[key] as string))
      throw new Error("Invalid herdr socket discovery response");
  return { api: paths.api as string, client: paths.client as string };
}

/** One bounded newline-JSON API request; mutations are never retried. */
export function herdrApiRequest(socketPath: string, method: string, params: Record<string, unknown> = {},
  options: { timeoutMs?: number; maxResponseBytes?: number; signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
  if (options.signal?.aborted) return Promise.reject(options.signal.reason);
  const id = randomUUID(), maxBytes = options.maxResponseBytes ?? 8 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let bytes = Buffer.alloc(0), settled = false;
    const done = (error?: Error, result?: Record<string, unknown>) => {
      if (settled) return;
      settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", aborted); socket.destroy();
      if (error) reject(error); else resolve(result!);
    };
    const timer = setTimeout(() => done(new Error("Herdr API request timed out")), options.timeoutMs ?? 15_000);
    timer.unref();
    const aborted = () => done(new DOMException("Herdr request cancelled", "AbortError"));
    options.signal?.addEventListener("abort", aborted, { once: true });
    socket.once("connect", () => socket.write(JSON.stringify({ id, method, params }) + "\n"));
    socket.on("error", error => done(new Error(`Herdr API connection failed: ${error.message}`)));
    socket.once("end", () => done(new Error("Herdr API closed before its response")));
    socket.on("data", value => {
      if (settled) return;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (bytes.length + chunk.length > maxBytes) { done(new Error("Herdr API response is too large")); return; }
      bytes = Buffer.concat([bytes, chunk]);
      const end = bytes.indexOf(10);
      if (end < 0) return;
      try {
        const response = JSON.parse(bytes.subarray(0, end).toString("utf8"));
        if (!response || typeof response !== "object" || response.id !== id) throw new Error("Invalid herdr API response");
        if (response.error) throw new Error(typeof response.error.message === "string" ? `herdr: ${response.error.message.slice(0, 500)}` : "Herdr API request failed");
        if (!response.result || typeof response.result !== "object" || Array.isArray(response.result)) throw new Error("Invalid herdr API response");
        done(undefined, response.result);
      } catch (error) { done(error instanceof Error ? error : new Error("Invalid herdr API response")); }
    });
  });
}
