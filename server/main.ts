import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { getRequestListener } from '@hono/node-server'
import { fileURLToPath } from 'node:url'
import { serveCanvasStatic } from './static.ts'
import { Hono } from 'hono'
import { WebSocketServer, type WebSocket } from 'ws'
import { Store, sourceConnectionKey, type Source } from './state.ts'
import { createApp } from './app.ts'
import { AccountStore } from './account.ts'
import { CompletionReads } from './completion-reads.ts'
import { TerminalManager, type TerminalTarget } from './terminals.ts'
import { allowedOrigin, parseAllowedOrigins, bearerToken } from './auth.ts'
import { authenticateWebSocket } from './websocket-auth.ts'
import { serveTerminalChannels, type TerminalChannel } from './terminal-channels.ts'
import { closeRuntimeConnections } from './source-connections.ts'
import {
  prepareOpenBridge,
  writeRemoteBridgeRegistry,
  installCanvasHelper,
} from './canvas-helper.ts'
import { followResources, listResources, withProgress } from './runtimes.ts'
import { SourceWatchers } from './source-watchers.ts'
import { editorAuthority } from './source-command.ts'
import { OpenDownloadService } from './open-download.ts'
import { AssetStore } from './assets.ts'
import { UploadService } from './uploads.ts'
import { WindowContentService } from './window-content.ts'
import { UrlForwardService } from './url-forward.ts'
import { CaptureService, serveCaptureRequest } from './capture.ts'
import { captureAddress } from './capture-address.ts'
import { SourcePreviewService } from './source-preview.ts'
import { captureToolbarHeight } from '../shared/capture.ts'
import { sendComposer } from './composer-send.ts'
import { buildInfo } from './build-info.ts'
import { announceLogging, log, watchEventLoop } from './log.ts'
import { logIdentifier } from '../shared/log-line.ts'
const dataDir = process.env.CANVAS_DATA_DIR ?? join(homedir(), '.local/share/canvas')
const accounts = new AccountStore(dataDir)
const account = accounts.account
const store = new Store(join(dataDir, 'canvas.db'))
const urlForwards = new UrlForwardService(store)
const captures = new CaptureService(store, {
  onChange: (sourceId, windowId) => {
    void terminals.captureChanged(sourceId, windowId)
  },
})
const assets = new AssetStore(dataDir, store)
const completionReads = new CompletionReads(store)
const terminals = new TerminalManager(
  completionReads,
  (source, windowId) => store.removeWindowReferences(source, [windowId]),
  (sourceId, windowId) =>
    store.normalTerminalSize(
      sourceId,
      windowId,
      captures.current(sourceId, windowId) ? captureToolbarHeight : 0,
    ),
  (sourceId, windowId) => captures.current(sourceId, windowId),
  (source, windowId) => store.markWindowRead(source, windowId),
)
const watchers = new SourceWatchers({
  sources: () => store.list<Source>('source'),
  follow: followResources,
  project: (source, resource) =>
    completionReads.projectResources(source, withProgress(resource, terminals.progress(source.id))),
})
completionReads.changes.subscribe((sourceId) => watchers.refresh(sourceId))
terminals.listingChanges.subscribe((sourceId) => watchers.refresh(sourceId))
store.on('change', (normalGeometryChanged: boolean) => {
  if (normalGeometryChanged) terminals.refreshNormalSizes()
  watchers.sync()
})
const uploads = new UploadService(terminals)
const helperBytes = readFileSync(new URL('../cli/canvas', import.meta.url))
const sourcePreviews = new SourcePreviewService(store, captures, helperBytes.toString('utf8'))
/** The session each terminal socket signed in with, and what each of its channels serves. */
const socketSessions = new WeakMap<import('ws').WebSocket, string>()
const channels = new WeakMap<TerminalChannel, { session: string; captureBase?: string }>()
const downloads = new OpenDownloadService({
  capture: async (source, windowId, paneId, header, socket, recipient) =>
    serveCaptureRequest(captures, socket, header, {
      source,
      windowId,
      paneId,
      session: recipient.sessionId,
      publicBase: channels.get(recipient.socket)?.captureBase,
    }),
  openUrl: (source, url, session) => urlForwards.open(source, url, session),
  directoryAuthority: editorAuthority,
  createUpload: (metadata) => assets.begin(metadata),
  readTemporary: (id, range) => assets.readTemporary(id, range),
  prepare: prepareOpenBridge,
  publishRemote: writeRemoteBridgeRegistry,
  installHelper: (source) => installCanvasHelper(source, helperBytes),
  resources: listResources,
  recipient: async (sourceId, windowId) => {
    const recipient = await terminals.downloadRecipient(sourceId, windowId)
    const socket = recipient?.socket
    const sessionId = socket && channels.get(socket)?.session
    return socket && sessionId && store.hasSession(sessionId)
      ? {
          socket,
          sessionId,
          isCurrent: () => store.hasSession(sessionId) && recipient!.isCurrent(),
        }
      : undefined
  },
})
const windowContent = new WindowContentService({
  store,
  assets,
  content: (source, spaceId, windowId) => terminals.content(source, spaceId, windowId),
  registerStaged: (assetId, sessionId) => downloads.registerStaged(assetId, sessionId),
})
const allowedOrigins = parseAllowedOrigins(process.env.CANVAS_ALLOWED_ORIGINS)
const app = createApp(store, account, terminals, {
  completionReads,
  watchers,
  updateAccount: (username, password) => accounts.update(username, password),
  allowedOrigins,
  openDownload: (ticket, session) => downloads.open(ticket, session),
  prepareDownload: (ticket, session, context) => downloads.prepare(ticket, session, context),
  previewFile: (id, temporary, session, publicBase) => {
    const assetId = temporary ? downloads.stagedAssetId(id, session) : id
    return sourcePreviews.open(
      assetId ? assets.origin(assetId, temporary) : undefined,
      session,
      publicBase,
    )
  },
  closeOpenBridge: (sourceId) => {
    uploads.closeSource(sourceId)
    windowContent.closeSource(sourceId)
    urlForwards.closeSource(sourceId)
    captures.closeSource(sourceId)
    return downloads.closeSource(sourceId)
  },
  assets,
  uploads,
  windowContent,
  openUrl: (source, url, session) => urlForwards.open(source, url, session),
})
app.post('/api/captured-apps/:id/stop', (c) => {
  const session = bearerToken(c.req.header('authorization'))
  if (!store.hasSession(session)) return c.json({ error: 'Please sign in' }, 401)
  return captures.stop(c.req.param('id'), session)
    ? c.json({ ok: true })
    : c.json({ error: 'Captured application unavailable' }, 404)
})
app.get('/api/*', (c) => c.json({ error: 'Not found' }, 404))
app.use('*', async (c, next) => {
  c.header('X-Frame-Options', 'DENY')
  c.header('Referrer-Policy', 'same-origin')
  return next()
})
const staticDir = resolve(
  process.env.CANVAS_STATIC_DIR ?? fileURLToPath(new URL('../web/', import.meta.url)),
)
const documents = new Hono()
documents.use('/api/document/:id/*', async (c, next) => {
  if (!captures.hasStaticPreview(c.req.param('id')!)) return c.notFound()
  c.header('Referrer-Policy', 'no-referrer')
  c.header('Cache-Control', 'no-store')
  return serveCanvasStatic(staticDir, `/api/document/${c.req.param('id')}`)(c, next)
})
const documentListener = getRequestListener(documents.fetch)
app.use('*', serveCanvasStatic(staticDir))
const requestListener = getRequestListener(app.fetch)
const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 })
let stopping = false
/** Ends a socket whose session ended; true if it did. */
function endExpired(ws: WebSocket) {
  const session = socketSessions.get(ws)
  if (session === undefined || store.hasSession(session)) return false
  ws.close(1008, 'Session expired')
  ws.terminate()
  return true
}
store.on('sessions', () => {
  for (const ws of wss.clients) endExpired(ws)
})
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) if (!endExpired(ws) && ws.readyState === 1) ws.ping()
}, 30_000)
heartbeat.unref()
const upgrade = (
  request: import('node:http').IncomingMessage,
  socket: import('node:stream').Duplex,
  head: Buffer,
) => {
  if (stopping) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  if (
    captures.handleUpgrade(request, socket, head) ||
    urlForwards.handleUpgrade(request, socket, head)
  )
    return
  const origin = request.headers.origin
  if (!origin || !allowedOrigin(origin, `http://${request.headers.host}`, allowedOrigins)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  let url: URL
  try {
    url = new URL(request.url ?? '/', `http://${request.headers.host}`)
  } catch {
    socket.destroy()
    return
  }
  if (url.pathname !== '/api/terminal') {
    socket.destroy()
    return
  }
  wss.handleUpgrade(request, socket, head, (ws) =>
    authenticateWebSocket(
      ws,
      (token) => store.hasSession(token),
      (token) => {
        let captureBase: string | undefined
        try {
          captureBase = captureAddress(url, request.headers['x-forwarded-prefix'])
        } catch {
          ws.close(1008, 'Invalid Canvas API base')
          return
        }
        socketSessions.set(ws, token)
        const socket = logSocket(ws, request)
        serveTerminalChannels(
          ws,
          (channel, target) => openWindowChannel(channel, target, token, captureBase),
          socket,
        )
      },
    ),
  )
}
/** Logs a socket's life under an identifier of its own, with the address it came from. */
function logSocket(ws: WebSocket, request: IncomingMessage) {
  const socket = logIdentifier(randomBytes(4).toString('hex'))
  // Behind a proxy the first forwarded hop is the browser. It is only ever logged.
  const forwarded = String(request.headers['x-forwarded-for'] ?? '')
    .split(',')[0]!
    .trim()
  const address = logIdentifier(forwarded || request.socket.remoteAddress || '')
  log('link', 'socket', { socket, address, state: 'open' })
  ws.send(
    JSON.stringify({
      type: 'hello',
      socket,
      version: buildInfo.version,
      revision: buildInfo.revision,
    }),
  )
  ws.once('close', (code) => log('link', 'socket', { socket, address, state: 'close', code }))
  return socket
}
/** Attaches a window to a channel of an authenticated socket. */
function openWindowChannel(
  channel: TerminalChannel,
  { sourceId, spaceId, windowId }: TerminalTarget,
  session: string,
  captureBase?: string,
) {
  const source = store.get<Source>('source', sourceId)
  if (!source) {
    channel.send({ type: 'status', status: 'error', error: 'Connection not found' })
    channel.close()
    return
  }
  const current = () => {
    const now = store.get<Source>('source', sourceId)
    return !!now && sourceConnectionKey(now) === sourceConnectionKey(source)
  }
  channels.set(channel, { session, captureBase })
  channel.once('close', () => uploads.disconnected(channel))
  channel.on('message', (message) => {
    if (!store.hasSession(session)) return
    const id = message.id
    if (message.type === 'upload-begin') {
      if (current())
        void uploads.begin(source, windowId, channel, session, {
          id: message.id,
          files: message.files,
          parts: message.parts,
        })
    } else if (message.type === 'composer-send') {
      if (current())
        void sendComposer(store, assets, uploads, source, windowId, channel, session, {
          id: message.id,
          composer: message.composer,
          version: message.version,
        })
    } else if (typeof id !== 'string') return
    else if (message.type === 'upload-cancel') uploads.cancel(channel, id)
    else if (message.type === 'upload-failed') uploads.failed(channel, id)
    else if (message.type === 'directory-received')
      downloads.directoryReceived(id, channel, session)
    else if (message.type === 'url-received') downloads.urlReceived(id, channel, session)
  })
  channel.once('close', downloads.retainSource(sourceId))
  channel.send({ type: 'status', status: 'connecting' })
  void terminals
    .connect(source, { sourceId, spaceId, windowId }, channel)
    .then(() => downloads.ensureSource(source).catch(() => {}))
    .catch((error) => {
      channel.send({ type: 'status', status: 'error', error: error.message })
      channel.close()
    })
}
const hosts = [
  ...new Set(
    (process.env.CANVAS_HOST ?? '127.0.0.1')
      .split(',')
      .map((host) => host.trim())
      .filter(Boolean),
  ),
]
if (!hosts.length) throw new Error('CANVAS_HOST requires a listening address')
announceLogging()
const eventLoop = watchEventLoop()
const port = Number(process.env.CANVAS_PORT ?? 3010)
const servers = hosts.map((host) => {
  const server = createServer((request, response) => {
    // Public path proxies expose the API, never another site's executable UI.
    if (request.headers['x-forwarded-prefix'] && !request.url?.startsWith('/api/')) {
      response.writeHead(404).end('Not found')
      return
    }
    if (request.url?.startsWith('/api/document/')) {
      void documentListener(request, response)
      return
    }
    if (!captures.handle(request, response) && !urlForwards.handle(request, response))
      void requestListener(request, response)
  })
  server.on('upgrade', upgrade)
  server.listen(port, host, () =>
    console.log(`Canvas listening on http://${host.includes(':') ? `[${host}]` : host}:${port}`),
  )
  return server
})
async function stop() {
  if (stopping) return
  stopping = true
  clearInterval(heartbeat)
  eventLoop[Symbol.dispose]()
  watchers[Symbol.dispose]()
  windowContent.close()
  await captures.close()
  await sourcePreviews.close()
  await urlForwards.close()
  await uploads.closeAll()
  await terminals.closeAll()
  await downloads.closeAll()
  await assets.close()
  await closeRuntimeConnections()
  store.emit('close')
  wss.close()
  setTimeout(() => process.exit(0), 3000).unref()
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
  store.close()
  process.exit(0)
}
process.on('SIGINT', () => void stop())
process.on('SIGTERM', () => void stop())
