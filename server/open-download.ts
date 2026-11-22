import { createServer, type Server, type Socket } from 'node:net'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rm, unlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable, type Readable } from 'node:stream'
import type { TerminalChannel } from './terminal-channels.ts'
import {
  sourceConnectionKey,
  type FileAsset,
  type FileAssetContext,
  type FileOrigin,
  type Source,
} from './state.ts'
import type { SourceResource } from './runtimes.ts'
import { directoryPath } from './directory-path.ts'
import { sanitizeEditorAuthority, type EditorAuthority } from '../shared/editor-target.ts'
import { webUrl, type OpenedUrl } from './url-forward.ts'
import { LineSplitter } from './lines.ts'

const MAX_HEADER = 16 * 1024
const MAX_TRANSFERS_PER_SOURCE = 4
const HANDSHAKE_TIMEOUT = 30_000
const CONTEXT_TIMEOUT = 10_000
const STAGED_LIFETIME = 60 * 60_000
const rejected = Buffer.from('{"ok":false}\n')

type DownloadState = 'offered' | 'accepted' | 'transferring'
type DownloadReason =
  'cancelled' | 'timed-out' | 'disconnected' | 'invalid-transfer' | 'not-attached'
export interface DownloadContext {
  canvasId?: string
  anchorId?: string
}
interface Upload {
  write(chunk: Buffer): Promise<void>
  complete(target: FileAssetContext): Promise<FileAsset & { temporary: boolean }>
  abort(): Promise<void>
}
export interface PreparedOpenBridge {
  nativeSocket: string
  remoteSocket?: string
  cleanup(): Promise<void>
}

export interface DownloadRecipient {
  socket: TerminalChannel
  sessionId: string
  isCurrent(): boolean
}

export interface OpenDownloadOptions {
  registryDirectory?: string
  socketDirectory?: string
  idleTimeoutMs?: number
  contextTimeoutMs?: number
  progressTimeoutMs?: number
  createUpload(metadata: { filename: string; size: number }): Promise<Upload>
  readTemporary(
    id: string,
    range?: { start: number; end: number },
  ): Promise<{ body: Readable; asset: FileAsset } | undefined>
  directoryAuthority?(source: Source): Promise<EditorAuthority>
  openUrl?(source: Source, url: string, sessionId: string): Promise<OpenedUrl> | OpenedUrl
  capture?(
    source: Source,
    windowId: string,
    paneId: string,
    header: Record<string, unknown>,
    socket: Socket,
    recipient: DownloadRecipient,
  ): Promise<void>
  prepare(source: Source, localSocket: string): Promise<PreparedOpenBridge>
  publishRemote?(source: Source, record: RegistryRecord): Promise<() => Promise<void>>
  installHelper?(source: Source): Promise<void>
  resources(source: Source): Promise<SourceResource>
  recipient(sourceId: string, windowId: string): Promise<DownloadRecipient | undefined>
}

interface RegistryRecord {
  version: 1
  nativeSocket: string
  socket: string
  secret: string
}

interface Bridge {
  source: Source
  record: RegistryRecord
  root: string
  server: Server
  sockets: Set<Socket>
  cleanupRuntime: () => Promise<void>
  cleanupRegistry: () => Promise<void>
  signature: string
}

/** One source's bridge: who uses it, and the bridge itself, started and closed in turn. */
interface SourceBridge {
  users: number
  idle?: ReturnType<typeof setTimeout>
  bridge?: Bridge
  /** The start or close running now; the next waits for it. */
  changing: Promise<void>
  /** A start for this connection, which another caller for it joins. */
  starting?: { signature: string; promise: Promise<void> }
}

interface DownloadTicket {
  origin?: FileOrigin
  id: string
  sessionId: string
  socket: Socket
  sourceId: string
  windowId: string
  filename: string
  size: number
  state: DownloadState
  transferred: number
  recipient: TerminalChannel
  lastProgressAt: number
  body?: Writable
  upload?: Upload
  context?: DownloadContext
  releaseSource: () => void
  timer?: ReturnType<typeof setTimeout>
  removeCloseListener: () => void
}

interface DirectoryTicket {
  kind: 'directory' | 'url'
  id: string
  sourceId: string
  sessionId: string
  socket: Socket
  recipient: TerminalChannel
  timer: ReturnType<typeof setTimeout>
  cleanup(): void
}

function jsonLine(value: unknown) {
  return Buffer.from(JSON.stringify(value) + '\n')
}

function safeFilename(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 255) return
  if (Buffer.from(value, 'utf8').toString('utf8') !== value) return
  if (value === '.' || value === '..' || /[/\\\x00-\x1f\x7f]/u.test(value)) return
  return value
}

/** What a helper asks for over the bridge, once its header is read and checked. */
type HelperRequest = { paneId: string } & (
  | { kind: 'capture' }
  | { kind: 'directory' | 'url'; path: string }
  | { kind: 'file'; filename: string; size: number; path?: string }
)
/** The helper's header as a request, or undefined for anything not exactly one. */
function helperRequest(
  header: Record<string, unknown>,
  secret: string,
  nativeSocket?: string,
): HelperRequest | undefined {
  const given = Buffer.from(typeof header.secret === 'string' ? header.secret : ''),
    expected = Buffer.from(secret)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return
  const { paneId } = header
  if (
    header.version !== 1 ||
    header.nativeSocket !== nativeSocket ||
    typeof paneId !== 'string' ||
    !paneId ||
    paneId.length > 256
  )
    return
  try {
    switch (header.kind) {
      case 'capture':
        return { kind: 'capture', paneId }
      case 'directory':
      case 'url':
        if (header.size !== undefined || header.filename !== undefined) return
        return {
          kind: header.kind,
          paneId,
          path: header.kind === 'url' ? webUrl(header.url).href : directoryPath(header.path),
        }
      case 'file': {
        const filename = safeFilename(header.filename),
          size = header.size
        if (!filename || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return
        return {
          kind: 'file',
          paneId,
          filename,
          size,
          ...(header.path === undefined ? {} : { path: directoryPath(header.path) }),
        }
      }
    }
  } catch {
    // An unusable path or URL.
  }
}

function contentDisposition(
  filename: string,
  mode: 'attachment' | 'inline' = 'attachment',
): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/gu, '_')
  const encoded = encodeURIComponent(filename).replace(
    /[!'()*]/gu,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `${mode}; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

export class OpenDownloadService {
  private sources = new Map<string, SourceBridge>()
  private tickets = new Map<string, DownloadTicket>()
  private directories = new Map<string, DirectoryTicket>()
  private staged = new Map<
    string,
    { sessionId: string; assetId: string; timer: ReturnType<typeof setTimeout> }
  >()
  private stopping = false
  private readonly registryDirectory: string
  private readonly socketDirectory: string

  constructor(private readonly options: OpenDownloadOptions) {
    this.registryDirectory =
      options.registryDirectory ?? join(homedir(), '.local/state/canvas/bridges')
    this.socketDirectory = options.socketDirectory ?? tmpdir()
  }

  private source(sourceId: string) {
    let entry = this.sources.get(sourceId)
    if (!entry) this.sources.set(sourceId, (entry = { users: 0, changing: Promise.resolve() }))
    return entry
  }
  /** Runs a start or close of the source's bridge after the one before it. */
  private change(entry: SourceBridge, action: () => Promise<void>) {
    const next = entry.changing.then(action)
    entry.changing = next.catch(() => {})
    return next
  }

  /** A browser or a transfer uses the source's bridge until the returned release. */
  retainSource(sourceId: string): () => void {
    const entry = this.source(sourceId)
    clearTimeout(entry.idle)
    entry.users++
    let released = false
    return () => {
      if (released) return
      released = true
      if (--entry.users || this.stopping) return
      entry.idle = setTimeout(() => {
        if (!entry.users) void this.closeSource(sourceId)
      }, this.options.idleTimeoutMs ?? 20_000)
      entry.idle.unref()
    }
  }

  async ensureSource(source: Source): Promise<void> {
    if (this.stopping) throw new Error('File transfer service is stopping')
    const entry = this.source(source.id),
      signature = sourceConnectionKey(source)
    if (entry.starting?.signature === signature) return await entry.starting.promise
    const promise = this.change(entry, async () => {
      if (entry.bridge?.signature === signature) return
      if (entry.bridge) await this.closeBridge(entry.bridge)
      await this.startSource(entry, source, signature)
    })
    const starting = (entry.starting = { signature, promise })
    try {
      await promise
    } finally {
      if (entry.starting === starting) entry.starting = undefined
    }
  }

  private async startSource(entry: SourceBridge, source: Source, signature: string) {
    if (this.options.installHelper) await this.options.installHelper(source)

    const root = await mkdtemp(join(this.socketDirectory, 'cv-open-'))
    await chmod(root, 0o700)
    const localSocket = join(root, 'bridge.sock')
    const secret = randomBytes(32).toString('base64url')
    const sockets = new Set<Socket>()
    let prepared: PreparedOpenBridge | undefined
    let cleanupRegistry = async () => {}
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.on('error', () => socket.destroy())
      this.accept(source, secret, socket)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(localSocket, resolve)
      })
      await chmod(localSocket, 0o600)
      prepared = await this.options.prepare(source, localSocket)
      const record: RegistryRecord = {
        version: 1,
        nativeSocket: prepared.nativeSocket,
        socket: source.transport === 'ssh' ? prepared.remoteSocket! : localSocket,
        secret,
      }
      if (!record.socket || !record.nativeSocket.startsWith('/'))
        throw new Error('Native terminal file bridge could not be identified')
      const bridge: Bridge = {
        source,
        record,
        root,
        server,
        sockets,
        cleanupRuntime: prepared.cleanup,
        cleanupRegistry: async () => {},
        signature,
      }
      entry.bridge = bridge
      if (source.transport === 'ssh') {
        if (!this.options.publishRemote)
          throw new Error('Remote file bridge registry is unavailable')
        bridge.cleanupRegistry = cleanupRegistry = await this.options.publishRemote(source, record)
      } else bridge.cleanupRegistry = cleanupRegistry = await this.publishLocal(record)
    } catch (error) {
      if (entry.bridge?.root === root) entry.bridge = undefined
      await cleanupRegistry().catch(() => {})
      if (prepared) await prepared.cleanup().catch(() => {})
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => {})
      await rm(root, { recursive: true, force: true })
      throw error
    }
  }

  private async publishLocal(record: RegistryRecord): Promise<() => Promise<void>> {
    await mkdir(this.registryDirectory, { recursive: true, mode: 0o700 })
    const directory = await lstat(this.registryDirectory)
    const uid = typeof process.getuid === 'function' ? process.getuid() : directory.uid
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      (directory.mode & 0o777) !== 0o700 ||
      directory.uid !== uid
    )
      throw new Error('Canvas helper registry permissions are unsafe')
    const filename = join(this.registryDirectory, `${randomUUID()}.json`)
    const handle = await open(filename, 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify(record))
      await handle.sync()
    } finally {
      await handle.close()
    }
    return async () => {
      try {
        if ((await readFile(filename, 'utf8')) === JSON.stringify(record)) await unlink(filename)
      } catch {}
    }
  }

  private accept(source: Source, secret: string, socket: Socket): void {
    socket.pause()
    socket.setTimeout(HANDSHAKE_TIMEOUT, () => socket.destroy())
    const lines = new LineSplitter(MAX_HEADER)
    let headerReceived = false
    socket.once('end', () => {
      if (!headerReceived && !socket.destroyed) socket.end(rejected)
    })
    const readHeader = (chunk: Buffer) => {
      let complete: Buffer[]
      try {
        complete = lines.push(chunk)
      } catch {
        socket.destroy()
        return
      }
      if (!complete.length) return
      headerReceived = true
      socket.off('data', readHeader)
      socket.pause()
      // The header alone: what follows is sent only after it is answered.
      if (complete.length > 1 || lines.rest.length) {
        socket.end(rejected)
        return
      }
      void this.acceptHeader(source, secret, socket, complete[0]!).catch(() => socket.destroy())
    }
    socket.on('data', readHeader)
    socket.resume()
  }

  private async acceptHeader(
    source: Source,
    secret: string,
    socket: Socket,
    line: Buffer,
  ): Promise<void> {
    const refuse = (reason?: string) => {
      socket.end(reason ? jsonLine({ ok: false, reason }) : rejected)
    }
    let header: unknown
    try {
      header = JSON.parse(line.toString('utf8'))
    } catch {
      return refuse()
    }
    const request =
      header && typeof header === 'object' && !Array.isArray(header)
        ? helperRequest(
            header as Record<string, unknown>,
            secret,
            this.sources.get(source.id)?.bridge?.record.nativeSocket,
          )
        : undefined
    if (!request) return refuse()
    const bridge = this.sources.get(source.id)?.bridge
    if (!bridge || bridge.source !== source || bridge.sockets.size > MAX_TRANSFERS_PER_SOURCE)
      return refuse()
    let resources: SourceResource
    try {
      resources = await this.options.resources(source)
    } catch {
      return refuse()
    }
    const matches = resources.spaces
      .flatMap((space) => space.windows)
      .filter((window) =>
        window.panes.some(
          (pane) => (source.runtime === 'hc' ? pane.terminalId : pane.id) === request.paneId,
        ),
      )
    if (matches.length !== 1) return refuse('pane-unavailable')
    const [window] = matches as [(typeof matches)[number]]
    const recipient = await this.options.recipient(source.id, window.id).catch(() => undefined)
    if (socket.destroyed) return
    if (
      !recipient ||
      !recipient.isCurrent() ||
      recipient.socket.readyState !== 1 ||
      !recipient.sessionId
    )
      return refuse('not-attached')
    if (request.kind === 'capture') {
      if (window.panes.length !== 1) return refuse('capture-requires-single-pane')
      if (!this.options.capture) return refuse('capture-unavailable')
      socket.once('close', this.retainSource(source.id))
      return this.options.capture(
        source,
        window.id,
        request.paneId,
        header as Record<string, unknown>,
        socket,
        recipient,
      )
    }
    if (request.kind !== 'file')
      return this.sendReference(source, request.path, socket, recipient, request.kind)
    const { filename, size, path } = request,
      windowId = window.id
    const id = randomBytes(32).toString('base64url')
    const ticket: DownloadTicket = {
      id,
      sessionId: recipient.sessionId,
      socket,
      sourceId: source.id,
      windowId,
      ...(path
        ? { origin: { sourceId: source.id, sourceKey: sourceConnectionKey(source), path } }
        : {}),
      filename,
      size,
      state: 'offered',
      transferred: 0,
      recipient: recipient.socket,
      lastProgressAt: 0,
      releaseSource: this.retainSource(source.id),
      removeCloseListener: () => {},
    }
    const onClose = () => this.finish(ticket, 'failed', 'disconnected')
    const onRecipientClose = () => {
      if (ticket.state === 'offered') this.finish(ticket, 'failed', 'not-attached')
    }
    recipient.socket.once('close', onRecipientClose)
    socket.once('close', onClose)
    ticket.removeCloseListener = () => {
      recipient.socket.off('close', onRecipientClose)
      socket.off('close', onClose)
    }
    this.tickets.set(id, ticket)
    socket.setTimeout(0)
    this.deadline(ticket, this.options.contextTimeoutMs ?? CONTEXT_TIMEOUT, 'not-attached')
    try {
      recipient.socket.send({ type: 'file-context', id, filename, size: ticket.size })
      socket.write(jsonLine({ state: 'offered', transferred: 0, size: ticket.size }))
    } catch {
      this.finish(ticket, 'failed', 'disconnected')
    }
  }

  private async sendReference(
    source: Source,
    path: string,
    socket: Socket,
    recipient: DownloadRecipient,
    kind: 'directory' | 'url',
  ): Promise<void> {
    if (kind === 'directory' ? !this.options.directoryAuthority : !this.options.openUrl) {
      socket.end(
        jsonLine({ ok: false, reason: kind === 'url' ? 'url-unavailable' : 'editor-unavailable' }),
      )
      return
    }
    const id = randomBytes(32).toString('base64url')
    const release = this.retainSource(source.id)
    const onClose = () => this.finishDirectory(id, 'not-attached')
    const onData = () => this.finishDirectory(id, 'invalid-directory')
    const timer = setTimeout(
      () => this.finishDirectory(id, 'not-started'),
      this.options.contextTimeoutMs ?? CONTEXT_TIMEOUT,
    )
    timer.unref()
    const ticket: DirectoryTicket = {
      id,
      kind,
      sourceId: source.id,
      sessionId: recipient.sessionId,
      socket,
      recipient: recipient.socket,
      timer,
      cleanup: () => {
        clearTimeout(timer)
        socket.off('close', onClose)
        socket.off('data', onData)
        recipient.socket.off('close', onClose)
        release()
      },
    }
    this.directories.set(id, ticket)
    socket.once('close', onClose)
    socket.once('data', onData)
    recipient.socket.once('close', onClose)
    socket.setTimeout(0)
    socket.resume()
    try {
      const data =
        kind === 'directory'
          ? {
              type: 'open-directory',
              path,
              authority: sanitizeEditorAuthority(await this.options.directoryAuthority!(source)),
            }
          : {
              type: 'open-url',
              ...(await this.options.openUrl!(source, path, recipient.sessionId)),
            }
      if (this.directories.get(id) !== ticket) return
      if (!recipient.isCurrent() || recipient.socket.readyState !== 1) {
        this.finishDirectory(id, 'not-attached')
        return
      }
      recipient.socket.send({ ...data, id })
    } catch {
      this.finishDirectory(id, kind === 'url' ? 'url-unavailable' : 'editor-unavailable')
    }
  }

  directoryReceived(id: string, socket: TerminalChannel, sessionId: string): boolean {
    return this.referenceReceived(id, socket, sessionId, 'directory')
  }
  urlReceived(id: string, socket: TerminalChannel, sessionId: string): boolean {
    return this.referenceReceived(id, socket, sessionId, 'url')
  }
  private referenceReceived(
    id: string,
    socket: TerminalChannel,
    sessionId: string,
    kind: 'directory' | 'url',
  ): boolean {
    const ticket = this.directories.get(id)
    if (
      !ticket ||
      ticket.kind !== kind ||
      ticket.recipient !== socket ||
      ticket.sessionId !== sessionId ||
      socket.readyState !== 1
    )
      return false
    this.finishDirectory(id)
    return true
  }

  private finishDirectory(id: string, reason?: string): void {
    const ticket = this.directories.get(id)
    if (!ticket) return
    this.directories.delete(id)
    ticket.cleanup()
    if (!ticket.socket.destroyed && !ticket.socket.writableEnded)
      ticket.socket.end(jsonLine(reason ? { ok: false, reason } : { ok: true }))
    const timer = setTimeout(() => ticket.socket.destroy(), 500)
    timer.unref()
    ticket.socket.once('close', () => clearTimeout(timer))
  }

  private deadline(ticket: DownloadTicket, milliseconds: number, reason: DownloadReason): void {
    clearTimeout(ticket.timer)
    ticket.timer = setTimeout(() => this.finish(ticket, 'failed', reason), milliseconds)
    ticket.timer.unref()
  }

  private finish(
    ticket: DownloadTicket,
    state: 'completed' | 'cancelled' | 'failed',
    reason?: DownloadReason,
  ): void {
    if (this.tickets.get(ticket.id) !== ticket) return
    this.tickets.delete(ticket.id)
    clearTimeout(ticket.timer)
    ticket.removeCloseListener()
    ticket.releaseSource()
    const socket = ticket.socket
    if (!socket.destroyed && !socket.writableEnded) {
      socket.end(
        jsonLine({
          ok: state === 'completed',
          state,
          transferred: ticket.transferred,
          size: ticket.size,
          ...(reason ? { reason } : {}),
        }),
      )
    }
    if (state !== 'completed') {
      ticket.body?.destroy(new Error(`File transfer ${reason || 'failed'}`))
      void ticket.upload?.abort().catch(() => {})
      // Deliver the rejection even while the peer is blocked sending, then
      // release a peer which does not read it. Never leave a paused socket open.
      const destroy = setTimeout(() => socket.destroy(), 500)
      destroy.unref()
      socket.once('close', () => clearTimeout(destroy))
    }
  }

  private cancelTicket(id: string): void {
    const ticket = this.tickets.get(id)
    if (ticket) this.finish(ticket, 'cancelled', 'cancelled')
  }

  prepare(ticketId: string, sessionId: string, context?: DownloadContext): boolean {
    const ticket = this.tickets.get(ticketId)
    if (!ticket || ticket.sessionId !== sessionId) return false
    if (ticket.state === 'offered') {
      ticket.context = { ...context }
      ticket.state = 'accepted'
      this.deadline(ticket, this.options.progressTimeoutMs ?? 60_000, 'timed-out')
      void this.copy(ticket).catch(() => this.finish(ticket, 'failed', 'invalid-transfer'))
    }
    return true
  }

  private async copy(ticket: DownloadTicket): Promise<void> {
    ticket.upload = await this.options.createUpload({
      filename: ticket.filename,
      size: ticket.size,
    })
    if (this.tickets.get(ticket.id) !== ticket) {
      await ticket.upload.abort()
      return
    }
    const socket = ticket.socket
    ticket.state = 'transferring'
    const upload = ticket.upload
    let received = 0
    const body = (ticket.body = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        received += chunk.length
        if (received > ticket.size) {
          callback(new Error('File transfer exceeded declared length'))
          return
        }
        void upload.write(chunk).then(
          () => {
            if (this.tickets.get(ticket.id) !== ticket) {
              callback(new Error('File transfer cancelled'))
              return
            }
            ticket.transferred = received
            this.deadline(ticket, this.options.progressTimeoutMs ?? 60_000, 'timed-out')
            const now = Date.now()
            if (now - ticket.lastProgressAt >= 100) {
              ticket.lastProgressAt = now
              if (!socket.destroyed)
                socket.write(
                  jsonLine({ state: 'transferring', transferred: received, size: ticket.size }),
                )
            }
            callback()
          },
          (error) => callback(error),
        )
      },
      final: (callback) => {
        if (received !== ticket.size) {
          callback(new Error('File transfer ended before declared length'))
          return
        }
        const complete = async () => {
          const asset = await upload.complete({
            ...ticket.context,
            sourceId: ticket.sourceId,
            windowId: ticket.windowId,
            origin: ticket.origin,
          })
          if (this.tickets.get(ticket.id) !== ticket) {
            callback(new Error('File transfer cancelled'))
            return
          }
          if (asset.temporary) this.registerStaged(asset.id, ticket.sessionId, ticket.id)
          // Success means the server has committed the complete file. Browser
          // download speed, save-dialog choices and HTTP aborts are independent.
          this.finish(ticket, 'completed')
          if (asset.temporary && ticket.recipient.readyState === 1) {
            try {
              ticket.recipient.send({
                type: 'download',
                id: ticket.id,
                url: `/api/downloads/${ticket.id}`,
                filename: ticket.filename,
                size: ticket.size,
                mime: asset.mime,
                sourcePreview: asset.sourcePreview,
              })
            } catch {}
          }
          callback()
        }
        void complete().catch((error) => callback(error))
      },
    }))
    const onError = (error: Error) => body.destroy(error)
    const onClose = () => {
      if (!socket.readableEnded) body.destroy(new Error('File transfer connection closed'))
    }
    socket.once('error', onError)
    socket.once('close', onClose)
    body.once('error', () => this.finish(ticket, 'failed', 'invalid-transfer'))
    body.once('close', () => {
      socket.off('error', onError)
      socket.off('close', onClose)
    })
    socket.write(jsonLine({ ok: true, state: 'transferring', transferred: 0, size: ticket.size }))
    socket.pipe(body)
  }

  registerStaged(assetId: string, sessionId: string, id: string = randomUUID()): string {
    const timer = setTimeout(() => this.staged.delete(id), STAGED_LIFETIME)
    timer.unref()
    this.staged.set(id, { sessionId, assetId, timer })
    return id
  }

  stagedAssetId(ticketId: string, sessionId: string): string | undefined {
    const staged = this.staged.get(ticketId)
    return staged?.sessionId === sessionId ? staged.assetId : undefined
  }

  async open(
    ticketId: string,
    sessionId: string,
  ): Promise<
    | {
        body: Readable
        headers: Record<string, string>
        previewHeaders?: Record<string, string>
        readRange(start: number, end: number): Promise<Readable | undefined>
      }
    | undefined
  > {
    const staged = this.staged.get(ticketId)
    if (!staged || staged.sessionId !== sessionId) return
    const file = await this.options.readTemporary(staged.assetId)
    if (!file) {
      clearTimeout(staged.timer)
      this.staged.delete(ticketId)
      return
    }
    const headers = {
      'Cache-Control': 'private, no-store',
      'Content-Disposition': contentDisposition(file.asset.filename),
      'Content-Length': String(file.asset.size),
      'Content-Type': 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
    }
    // Use the staged asset MIME; preview rendering belongs to the browser.
    // The ticket stays bound to its owner.
    const previewHeaders = {
      ...headers,
      'Content-Type': file.asset.mime,
      'Content-Disposition': contentDisposition(file.asset.filename, 'inline'),
      'Content-Security-Policy':
        file.asset.mime === 'application/pdf'
          ? "default-src 'none'; frame-ancestors 'self'"
          : "default-src 'none'; sandbox; frame-ancestors 'self'",
    }
    return {
      body: file.body,
      headers,
      previewHeaders,
      readRange: async (start, end) => {
        if (this.staged.get(ticketId) !== staged || staged.sessionId !== sessionId) return
        return (await this.options.readTemporary(staged.assetId, { start, end }))?.body
      },
    }
  }

  async closeSource(sourceId: string): Promise<void> {
    const entry = this.sources.get(sourceId)
    if (!entry) return
    clearTimeout(entry.idle)
    await this.change(entry, async () => {
      if (entry.bridge) await this.closeBridge(entry.bridge)
    })
    if (!entry.users && !entry.bridge && this.sources.get(sourceId) === entry)
      this.sources.delete(sourceId)
  }

  private async closeBridge(bridge: Bridge): Promise<void> {
    const sourceId = bridge.source.id,
      entry = this.sources.get(sourceId)
    if (entry?.bridge === bridge) entry.bridge = undefined
    for (const [id, ticket] of this.tickets) if (ticket.sourceId === sourceId) this.cancelTicket(id)
    for (const [id, ticket] of this.directories)
      if (ticket.sourceId === sourceId) this.finishDirectory(id, 'not-attached')
    for (const socket of bridge.sockets) socket.destroy()
    await bridge.cleanupRegistry().catch(() => {})
    await bridge.cleanupRuntime().catch(() => {})
    await new Promise<void>((resolve) => bridge.server.close(() => resolve()))
    await rm(bridge.root, { recursive: true, force: true })
  }

  async closeAll(): Promise<void> {
    this.stopping = true
    for (const entry of this.sources.values()) entry.users = 0
    await Promise.all([...this.sources.keys()].map((id) => this.closeSource(id)))
    for (const id of this.tickets.keys()) this.cancelTicket(id)
    for (const id of this.directories.keys()) this.finishDirectory(id, 'not-attached')
    for (const staged of this.staged.values()) clearTimeout(staged.timer)
    this.staged.clear()
  }
}
