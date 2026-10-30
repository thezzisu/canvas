import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Store, FileAsset, FileNodeContext } from "./state.ts";

const CHUNK_LIMIT = 8 * 1024;

export type FilePreview = FileAsset["preview"];

export function sniffFile(bytes: Uint8Array, complete = true): { mime: string; preview: FilePreview } {
  const value = Buffer.from(bytes);
  if (value.length >= 8 && value.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return { mime: "image/png", preview: "image" };
  if (value.length >= 3 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff)
    return { mime: "image/jpeg", preview: "image" };
  if (value.length >= 6 && ["GIF87a", "GIF89a"].includes(value.subarray(0, 6).toString("ascii")))
    return { mime: "image/gif", preview: "image" };
  if (value.length >= 12 && value.toString("ascii", 0, 4) === "RIFF" && value.toString("ascii", 8, 12) === "WEBP")
    return { mime: "image/webp", preview: "image" };
  if (value.length >= 12 && value.toString("ascii", 4, 8) === "ftyp" &&
      ["avif", "avis"].includes(value.toString("ascii", 8, 12)))
    return { mime: "image/avif", preview: "image" };
  if (value.length >= 5 && value.toString("ascii", 0, 5) === "%PDF-")
    return { mime: "application/pdf", preview: "pdf" };
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(value, { stream: !complete });
    const documentStart = text.replace(/^\uFEFF/u, "").replace(/^(?:\s*<!--[\s\S]*?-->\s*)+/u, "");
    if (/^\s*(?:<\?xml\b|<!doctype\s+html\b|<html\b|<head\b|<body\b|<script\b|<svg\b)/iu.test(documentStart))
      return { mime: "application/octet-stream", preview: "file" };
    if (![...text].some(char => {
      const code = char.codePointAt(0)!;
      return code === 0 || (code < 0x20 && ![9, 10, 12, 13].includes(code)) || (code >= 0x7f && code <= 0x9f);
    })) return { mime: "text/plain; charset=utf-8", preview: "text" };
  } catch { /* Unknown binary content stays opaque. */ }
  return { mime: "application/octet-stream", preview: "file" };
}

function safeFilename(value: string): string {
  if (!value || Buffer.byteLength(value, "utf8") > 255 || Buffer.from(value).toString() !== value ||
      /[/\\\x00-\x1f\x7f]/u.test(value) || value === "." || value === "..")
    throw new Error("Invalid filename");
  return value;
}

async function writeAll(file: FileHandle, chunk: Buffer, position: number) {
  let offset = 0;
  while (offset < chunk.length) {
    const result = await file.write(chunk, offset, chunk.length - offset, position + offset);
    if (!result.bytesWritten) throw new Error("Could not write file asset");
    offset += result.bytesWritten;
  }
}

export interface AssetUpload {
  write(chunk: Uint8Array): Promise<void>;
  complete(context: FileNodeContext, signal?: AbortSignal): Promise<FileAsset & { temporary: boolean }>;
  abort(): Promise<void>;
}

export class AssetStore {
  private readonly directory: string;
  private readonly temporary: string;
  private readonly staged: string;
  private cleanupQueued = false;
  private closed = false;
  private initialized?: Promise<void>;
  private stagedFiles = new Map<string, { asset: FileAsset; expiresAt: number; timer: ReturnType<typeof setTimeout> }>();

  constructor(dataDirectory: string, private readonly store: Store, private readonly options: { temporaryTtlMs?: number } = {}) {
    this.directory = join(dataDirectory, "files");
    this.temporary = join(dataDirectory, "tmp");
    this.staged = join(this.temporary, "staged");
    store.on("change", this.scheduleCleanup);
  }

  private scheduleCleanup = () => {
    if (this.cleanupQueued || this.closed) return;
    this.cleanupQueued = true;
    queueMicrotask(() => {
      this.cleanupQueued = false;
      if (!this.closed) void this.cleanupOrphans().catch(() => {});
    });
  };

  async begin(input: { filename: string; size: number }): Promise<AssetUpload> {
    if (this.closed) throw new Error("File storage is closed");
    const filename = safeFilename(input.filename);
    if (!Number.isSafeInteger(input.size) || input.size < 0) throw new Error("Invalid file size");
    await this.initialize();
    const partialPath = join(this.temporary, `${randomUUID()}.part`);
    const file = await open(partialPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    let written = 0;
    let prefix = Buffer.alloc(0);
    let active = true;
    const abort = async () => {
      if (!active) return;
      active = false;
      await file.close().catch(() => {});
      await rm(partialPath, { force: true });
    };
    return {
      write: async (inputChunk) => {
        if (!active) throw new Error("Upload is closed");
        const chunk = Buffer.from(inputChunk);
        if (written + chunk.length > input.size) throw new Error("File transfer exceeded declared length");
        if (prefix.length < CHUNK_LIMIT) prefix = Buffer.concat([prefix, chunk.subarray(0, CHUNK_LIMIT - prefix.length)]);
        await writeAll(file, chunk, written);
        written += chunk.length;
      },
      complete: async (context, signal) => {
        if (!active) throw new Error("Upload is closed");
        if (written !== input.size) throw new Error("File transfer ended before declared length");
        const id = randomUUID();
        const temporary = !context.canvasId || context.canvasId === "overview";
        const directoryPath = temporary ? this.staged : this.directory;
        const path = join(directoryPath, id);
        try {
          signal?.throwIfAborted();
          await file.sync();
          await file.close();
          signal?.throwIfAborted();
          if (!active) throw new Error("Upload is closed");
          const detected = /\.(?:html?|xhtml|svg|xml|js|mjs|cjs)$/iu.test(filename)
            ? { mime: "application/octet-stream", preview: "file" as const }
            : sniffFile(prefix, written <= prefix.length);
          const asset: FileAsset = {
            id, filename, size: written, mime: detected.mime, preview: detected.preview,
            createdAt: Date.now(),
          };
          await rename(partialPath, path);
          const directory = await open(directoryPath, constants.O_RDONLY | constants.O_DIRECTORY);
          try { await directory.sync(); } finally { await directory.close(); }
          signal?.throwIfAborted();
          if (!active || this.closed) throw new Error("Upload is closed");
          if (temporary) {
            const ttl = this.options.temporaryTtlMs ?? 60 * 60_000;
            const timer = setTimeout(() => { void this.discardTemporary(id).catch(() => {}); }, ttl);
            timer.unref();
            this.stagedFiles.set(id, { asset, expiresAt: Date.now() + ttl, timer });
          } else if (!this.store.addFileNode(asset, context)) {
            throw new Error("File destination no longer exists");
          }
          active = false;
          return { ...asset, temporary };
        } catch (error) {
          active = false;
          await file.close().catch(() => {});
          await rm(path, { force: true });
          await rm(partialPath, { force: true });
          throw error;
        }
      },
      abort,
    };
  }

  async read(id: string): Promise<{ body: Readable; asset: FileAsset } | undefined> {
    if (this.closed) return undefined;
    await this.initialize();
    const asset = this.store.fileAsset(id);
    if (!asset) return undefined;
    return await this.openAsset(join(this.directory, id), asset);
  }

  async readTemporary(id: string): Promise<{ body: Readable; asset: FileAsset } | undefined> {
    if (this.closed) return undefined;
    await this.initialize();
    const staged = this.stagedFiles.get(id);
    if (!staged) return undefined;
    if (staged.expiresAt <= Date.now()) {
      await this.discardTemporary(id);
      return undefined;
    }
    return await this.openAsset(join(this.staged, id), staged.asset);
  }

  async discardTemporary(id: string): Promise<void> {
    const staged = this.stagedFiles.get(id);
    if (!staged) return;
    clearTimeout(staged.timer);
    this.stagedFiles.delete(id);
    await rm(join(this.staged, id), { force: true });
  }

  private async openAsset(path: string, asset: FileAsset): Promise<{ body: Readable; asset: FileAsset } | undefined> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const info = await handle.stat();
      if (!info.isFile() || info.size !== asset.size) {
        await handle.close();
        return undefined;
      }
      return { body: handle.createReadStream(), asset };
    } catch { await handle?.close().catch(() => {}); return undefined; }
  }

  private initialize(): Promise<void> {
    this.initialized ??= (async () => {
      await privateDirectory(this.temporary);
      await privateDirectory(this.directory);
      await privateDirectory(this.staged);
      // Only names created by this store are eligible for crash recovery.
      // A committed metadata row always wins over a leftover directory entry.
      const generated = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu;
      for (const entry of await readdir(this.temporary))
        if (entry.endsWith(".part") && generated.test(entry.slice(0, -5)))
          await rm(join(this.temporary, entry), { force: true });
      for (const entry of await readdir(this.directory))
        if (generated.test(entry) && !this.store.fileAsset(entry))
          await rm(join(this.directory, entry), { force: true });
      for (const entry of await readdir(this.staged))
        if (generated.test(entry)) await rm(join(this.staged, entry), { force: true });
      await this.cleanupOrphans();
    })();
    return this.initialized;
  }

  private async cleanupOrphans() {
    const assets = this.store.fileAssetIds();
    for (const id of assets) {
      if (this.closed) return;
      if (this.store.removeFileAssetIfUnreferenced(id))
        await rm(join(this.directory, id), { force: true }).catch(() => {});
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.store.off("change", this.scheduleCleanup);
    await this.initialized?.catch(() => {});
    await Promise.all([...this.stagedFiles.keys()].map(id => this.discardTemporary(id)));
  }
}

async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077))
    throw new Error("File storage directory is not private");
}
