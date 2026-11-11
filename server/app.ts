import { LayoutConflict } from './state.ts'
import type { CompletionReads } from './completion-reads.ts'
import { Hono } from 'hono'
import { Readable } from 'node:stream'
import { bodyLimit } from 'hono/body-limit'
import { randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { verifyPassword, bearerToken, allowedOrigin } from './auth.ts'
import { accountUsername, accountPassword, type Account } from './account.ts'
import { MediaTickets, mediaPath } from './media.ts'
import { receiveCanvasFile, receiveFile } from './canvas-files.ts'
import { buildInfo } from './build-info.ts'
import { settingsPatchSchema } from './settings.ts'
import {
  Store,
  sourceSchema,
  sourceConnectionKey,
  canvasSchema,
  itemSchema,
  nodeLayoutSchema,
  noteNodeSchema,
  noteColorSchema,
  isTerminalNode,
  composerKey,
  type Source,
  type Canvas,
} from './state.ts'
import * as runtimes from './runtimes.ts'
import { WriteOrder, parseWriteMark } from './write-order.ts'
import { layoutFields, type LayoutField, type LayoutUpdate } from '../shared/layout.ts'
import type { TerminalManager } from './terminals.ts'
import type { CanvasNotification } from '../shared/notification.ts'
import type { DownloadContext } from './open-download.ts'
import type { AssetStore } from './assets.ts'
import type { UploadService } from './uploads.ts'
import type { WindowContentService } from './window-content.ts'
import { captureAddress } from './capture-address.ts'
import { SourcePreviewError } from './source-preview.ts'
import {
  BackgroundError,
  DEFAULT_BACKGROUND_OPACITY,
  backgroundContentType,
  validateBackground,
  readBackground,
  storedBackgroundContentType,
} from './backgrounds.ts'
const nameSchema = z.object({ name: z.string().trim().min(1).max(100) }).strict()
const sourceProbeSchema = z.object(sourceSchema.shape).omit({ id: true, name: true }).strict()
const createWindowSchema = z.object({ name: z.string().trim().max(100).optional() }).strict()
const createSpaceSchema = createWindowSchema.extend({
  sourceSpaceId: z.string().min(1).max(100).optional(),
})
const paneContextSchema = z
  .object({ bootId: z.string().min(1).max(4096), paneId: z.string().min(1).max(4096) })
  .strict()
const paneActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('rename'), name: z.string().trim().max(200) }).strict(),
  z.object({ action: z.enum(['split-right', 'split-down', 'zoom', 'close']) }).strict(),
])
const opacitySchema = z.number().finite().min(0).max(1)
const backgroundOpacitySchema = z.object({ opacity: opacitySchema }).strict()
const nodeListSchema = z.object({ nodes: z.array(itemSchema).max(500) }).strict()
const layoutSchema = z
  .object({
    nodes: z
      .array(
        nodeLayoutSchema
          .pick({ id: true, x: true, y: true, width: true, height: true })
          .partial()
          .required({ id: true })
          .extend({ expected: nodeLayoutSchema.omit({ id: true }).partial().optional() })
          .refine(
            (value) =>
              !value.expected ||
              (Object.keys(value.expected).length > 0 &&
                ['x', 'y', 'width', 'height'].every(
                  (field) =>
                    (value[field as keyof typeof value] !== undefined) ===
                    (value.expected?.[field as keyof typeof value.expected] !== undefined),
                )),
          ),
      )
      .max(500),
  })
  .strict()
const noteCreateSchema = noteNodeSchema.omit({ id: true, type: true }).extend({
  x: nodeLayoutSchema.shape.x.default(80),
  y: nodeLayoutSchema.shape.y.default(80),
  width: nodeLayoutSchema.shape.width.default(320),
  height: nodeLayoutSchema.shape.height.default(240),
})
const notePatchSchema = z
  .object({
    title: z.string().max(200).optional(),
    content: z.string().max(200_000).optional(),
    color: noteColorSchema.optional(),
  })
  .strict()
const isBackgroundUpload = (method: string, path: string) =>
  method === 'PUT' && /^\/api\/canvases\/[^/]+\/background$/.test(path)
const isInboxUpload = (method: string, path: string) =>
  method === 'PUT' && /^\/api\/uploads\/[A-Za-z0-9_-]+$/.test(path)
const isCanvasFileUpload = (method: string, path: string) =>
  method === 'POST' &&
  (/^\/api\/canvases\/[^/]+\/(?:notes\/[^/]+\/)?files$/.test(path) ||
    /^\/api\/sources\/[^/]+\/windows\/[^/]+\/composer\/files$/.test(path))
const writtenFields = (node: LayoutUpdate) =>
  layoutFields.filter((field) => node[field] !== undefined)
const pick = <Value extends object, Key extends keyof Value>(value: Value, keys: readonly Key[]) =>
  Object.fromEntries(keys.map((key) => [key, value[key]])) as Pick<Value, Key>
const composerSchema = z.object({ content: z.string().max(200_000) }).strict()
export type { Account } from './account.ts'
export interface DownloadResponse {
  body: Readable
  headers: Record<string, string>
  previewHeaders?: Record<string, string>
  readRange?(start: number, end: number): Promise<Readable | undefined>
}
export function createApp(
  store: Store,
  account: Account,
  terminals: TerminalManager,
  options: {
    completionReads?: CompletionReads
    updateAccount?: (username: string, password?: string) => void
    allowedOrigins?: ReadonlySet<string>
    openDownload?: (ticket: string, sessionId: string) => Promise<DownloadResponse | undefined>
    prepareDownload?: (ticket: string, sessionId: string, context?: DownloadContext) => boolean
    previewFile?: (
      id: string,
      temporary: boolean,
      sessionId: string,
      publicBase: string,
    ) => Promise<{ id: string; url: string }>
    closeOpenBridge?: (sourceId: string) => Promise<void>
    assets?: AssetStore
    uploads?: UploadService
    windowContent?: WindowContentService
    openUrl?: (
      source: Source,
      url: string,
      sessionId: string,
    ) => { url: string; forwarded: boolean }
  } = {},
) {
  const app = new Hono()
  const order = new WriteOrder()
  const origins = options.allowedOrigins || new Set<string>()
  async function loadFile(id: string, download: boolean): Promise<DownloadResponse | undefined> {
    const file = await options.assets?.read(id)
    if (!file) return
    const { asset, body } = file
    const mode = download ? 'attachment' : 'inline'
    const fallback = asset.filename.replace(/[^\x20-\x7e]|["\\]/gu, '_')
    const encoded = encodeURIComponent(asset.filename).replace(
      /[!'()*]/gu,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    )
    return {
      body,
      headers: {
        'Content-Type': asset.mime,
        'Content-Length': String(asset.size),
        'Content-Disposition': `${mode}; filename="${fallback}"; filename*=UTF-8''${encoded}`,
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin',
        // Chromium's isolated PDF viewer requires a response without sandbox.
        'Content-Security-Policy':
          asset.mime === 'application/pdf'
            ? "default-src 'none'; frame-ancestors 'self'"
            : "default-src 'none'; sandbox; frame-ancestors 'self'",
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'private, no-store',
      },
      readRange: async (start, end) => (await options.assets?.read(id, { start, end }))?.body,
    }
  }
  const media = new MediaTickets(
    (token) => store.hasSession(token),
    async (path, session, download) => {
      if (path.startsWith('/api/files/'))
        return loadFile(path.slice('/api/files/'.length), download)
      if (path.startsWith('/api/downloads/')) {
        const file = await options.openDownload?.(path.slice('/api/downloads/'.length), session)
        return (
          file && {
            ...file,
            headers: download ? file.headers : (file.previewHeaders ?? file.headers),
          }
        )
      }
      const response = await app.request(
        `http://canvas.internal${path}${download ? '?download=1' : '?preview=1'}`,
        {
          headers: { Authorization: `Bearer ${session}` },
        },
      )
      if (!response.ok || !response.body) {
        await response.body?.cancel()
        return
      }
      return {
        body: Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
        headers: Object.fromEntries(response.headers),
      }
    },
    origins,
  )
  let attempts: { count: number; until: number } | undefined
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    c.header('X-Content-Type-Options', 'nosniff')
    const origin = c.req.header('origin')
    if (origin && !allowedOrigin(origin, new URL(c.req.url).origin, origins))
      return c.json({ error: 'Request origin rejected' }, 403)
    if (origin) {
      c.header('Access-Control-Allow-Origin', origin)
      c.header('Vary', 'Origin')
      c.header(
        'Access-Control-Expose-Headers',
        'Content-Length, Content-Disposition, Content-Range, Accept-Ranges',
      )
    }
    if (c.req.method === 'OPTIONS') {
      c.header('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS')
      c.header('Access-Control-Allow-Headers', 'Authorization, Canvas-Write, Content-Type, Range')
      c.header('Access-Control-Max-Age', '600')
      return c.body(null, 204)
    }
    const ticketRequest =
      ['GET', 'HEAD'].includes(c.req.method) && /^\/api\/media\/[A-Za-z0-9_-]+$/.test(c.req.path)
    if (
      !['/api/login', '/api/session'].includes(c.req.path) &&
      !ticketRequest &&
      !store.hasSession(bearerToken(c.req.header('authorization')))
    )
      return c.json({ error: 'Please sign in' }, 401)
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      if (isBackgroundUpload(c.req.method, c.req.path))
        backgroundContentType(c.req.header('content-type'))
      else if (
        isInboxUpload(c.req.method, c.req.path) ||
        isCanvasFileUpload(c.req.method, c.req.path)
      ) {
        if (c.req.header('content-type') !== 'application/octet-stream')
          return c.json({ error: 'File bytes required' }, 415)
      } else if (!c.req.header('content-type')?.startsWith('application/json'))
        return c.json({ error: 'JSON required' }, 415)
    }
    return next()
  })
  const jsonBodyLimit = bodyLimit({
    maxSize: 1024 * 1024,
    onError: (c) => c.json({ error: 'Request too large' }, 413),
  })
  app.use('/api/*', (c, next) =>
    isBackgroundUpload(c.req.method, c.req.path) ||
    isInboxUpload(c.req.method, c.req.path) ||
    isCanvasFileUpload(c.req.method, c.req.path)
      ? next()
      : jsonBodyLimit(c, next),
  )
  app.get('/api/session', (c) =>
    c.json({
      authenticated: store.hasSession(bearerToken(c.req.header('authorization'))),
      username: account.username,
      server: buildInfo,
    }),
  )
  app.post('/api/media-tickets', async (c) => {
    const input = z
      .object({ path: z.string().regex(mediaPath), download: z.boolean().optional() })
      .strict()
      .parse(await c.req.json())
    const ticket = await media.create(
      input.path,
      bearerToken(c.req.header('authorization')),
      input.download,
    )
    return ticket ? c.json(ticket) : c.json({ error: 'Media not found' }, 404)
  })
  app.on(['GET', 'HEAD'], '/api/media/:ticket', async (c) => {
    const response = await media.open(c.req.param('ticket'), c.req.method, c.req.header('range'))
    return response || c.json({ error: 'Media link expired' }, 404)
  })
  app.put('/api/uploads/:token', async (c) => {
    const status =
      (await options.uploads?.receive(
        c.req.param('token'),
        bearerToken(c.req.header('authorization')),
        c.req.raw,
      )) ?? 404
    return status === 204
      ? c.body(null, 204)
      : c.json({ error: status === 404 ? 'Upload expired' : 'Upload failed' }, status)
  })
  app.post('/api/canvases/:id/files', async (c) => {
    const id = c.req.param('id')
    if (id === 'overview') return c.json({ error: 'Overview is read-only' }, 403)
    if (!store.get('canvas', id) || !options.assets)
      return c.json({ error: 'Canvas not found' }, 404)
    const input = z
      .object({
        filename: z.string().min(1).max(255),
        size: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        x: z.coerce.number().finite().min(-1e7).max(1e7),
        y: z.coerce.number().finite().min(-1e7).max(1e7),
      })
      .strict()
      .parse(c.req.query())
    return c.json(
      await receiveCanvasFile(
        store,
        options.assets,
        id,
        input,
        c.req.raw,
        bearerToken(c.req.header('authorization')),
      ),
      201,
    )
  })
  app.post('/api/canvases/:id/notes/:note/files', async (c) => {
    const id = c.req.param('id'),
      noteId = c.req.param('note')
    if (!store.hasNote(id, noteId) || !options.assets)
      return c.json({ error: 'Note not found' }, 404)
    const input = z
      .object({
        filename: z.string().min(1).max(255),
        size: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      })
      .strict()
      .parse(c.req.query())
    return c.json(
      await receiveCanvasFile(
        store,
        options.assets,
        id,
        { ...input, noteId },
        c.req.raw,
        bearerToken(c.req.header('authorization')),
      ),
      201,
    )
  })
  app.post('/api/canvases/:id/notes/:note/file-references', async (c) => {
    const input = z
      .object({ assetIds: z.array(z.string().uuid()).min(1).max(64) })
      .strict()
      .parse(await c.req.json())
    const assets = store.referenceNoteFiles(c.req.param('id'), c.req.param('note'), input.assetIds)
    return assets ? c.json(assets) : c.json({ error: 'Note or file not found' }, 404)
  })
  const composerTarget = (c: { req: { param(name: string): string } }) => ({
    sourceId: c.req.param('id'),
    windowId: c.req.param('window'),
  })
  app.patch('/api/sources/:id/windows/:window/composer', async (c) => {
    const target = composerTarget(c),
      mark = parseWriteMark(c.req.header('canvas-write')),
      resource = `composer/${composerKey(target)}`
    if (!store.acceptsWindow(target)) return c.json({ error: 'Window not found' }, 404)
    const { content } = composerSchema.parse(await c.req.json())
    if (!order.fresh(mark, resource, ['content']).length)
      return c.json(store.currentComposer(target))
    const view = store.updateComposer(target, content)
    order.record(mark, resource, ['content'])
    return c.json(view)
  })
  app.post('/api/sources/:id/windows/:window/composer/files', async (c) => {
    const target = composerTarget(c)
    if (!store.acceptsWindow(target) || !options.assets)
      return c.json({ error: 'Window not found' }, 404)
    const input = z
      .object({
        filename: z.string().min(1).max(255),
        size: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      })
      .strict()
      .parse(c.req.query())
    return c.json(
      await receiveFile(
        store,
        options.assets,
        input,
        { composer: target },
        () => store.acceptsWindow(target),
        c.req.raw,
        bearerToken(c.req.header('authorization')),
      ),
      201,
    )
  })
  app.post('/api/sources/:id/windows/:window/composer/file-references', async (c) => {
    const input = z
      .object({ assetIds: z.array(z.string().uuid()).min(1).max(64) })
      .strict()
      .parse(await c.req.json())
    const assets = store.referenceComposerFiles(composerTarget(c), input.assetIds)
    return assets ? c.json(assets) : c.json({ error: 'Window or file not found' }, 404)
  })
  app.get('/api/downloads/:ticket', async (c) => {
    if (c.req.method !== 'GET') return c.body(null, 405)
    const download = await options.openDownload?.(
      c.req.param('ticket'),
      bearerToken(c.req.header('authorization')),
    )
    if (!download) return c.json({ error: 'Download expired' }, 404)
    const headers =
      c.req.query('preview') === '1' && c.req.query('download') !== '1'
        ? (download.previewHeaders ?? download.headers)
        : download.headers
    return c.newResponse(Readable.toWeb(download.body) as ReadableStream, 200, headers)
  })
  app.post('/api/downloads/:ticket', async (c) => {
    const context = z
      .object({
        canvasId: z.union([z.string().uuid(), z.literal('overview')]).optional(),
        anchorId: z.string().max(150).optional(),
      })
      .strict()
      .parse(await c.req.json())
    const prepared = options.prepareDownload?.(
      c.req.param('ticket'),
      bearerToken(c.req.header('authorization')),
      context,
    )
    return prepared ? c.body(null, 204) : c.json({ error: 'Download expired' }, 404)
  })
  app.get('/api/sources/:id/spaces/:space/windows/:window/text', async (c) => {
    const source = store.get<Source>('source', c.req.param('id'))
    if (!source || !options.windowContent) return c.json({ error: 'Window not found' }, 404)
    const panes = await options.windowContent.read(
      source,
      c.req.param('space'),
      c.req.param('window'),
      bearerToken(c.req.header('authorization')),
    )
    if (panes.some((pane) => pane.incomplete))
      return c.json({ error: 'Some window content could not be read' }, 503)
    return c.json({
      text: panes
        .map((pane) => pane.lines.join('\n').trimEnd())
        .filter(Boolean)
        .join('\n\n'),
    })
  })
  app.post('/api/sources/:id/spaces/:space/windows/:window/pane-context', async (c) => {
    const point = z
      .object({
        column: z.number().int().min(0).max(4095),
        row: z.number().int().min(0).max(4095),
        cols: z.number().int().min(1).max(4096),
        rows: z.number().int().min(1).max(4096),
        layout: z.string().uuid(),
      })
      .strict()
      .parse(await c.req.json())
    const connection = source(c.req.param('id')),
      key = sourceConnectionKey(connection)
    const target = await terminals.paneContext(
      connection,
      c.req.param('space'),
      c.req.param('window'),
      point,
    )
    if (!store.hasSession(bearerToken(c.req.header('authorization'))))
      return c.json({ error: 'Please sign in' }, 401)
    if (sourceConnectionKey(source(connection.id)) !== key)
      return c.json({ error: 'Connection changed' }, 409)
    return c.json({ pane: target || null })
  })
  app.post('/api/sources/:id/spaces/:space/windows/:window/pane-action', async (c) => {
    const { pane, command } = z
      .object({ pane: paneContextSchema, command: paneActionSchema })
      .strict()
      .parse(await c.req.json())
    const connection = source(c.req.param('id')),
      key = sourceConnectionKey(connection),
      session = bearerToken(c.req.header('authorization'))
    const authorized = () => {
      const current = store.get<Source>('source', connection.id)
      return store.hasSession(session) && !!current && sourceConnectionKey(current) === key
    }
    const windowId = c.req.param('window')
    await terminals.paneAction(
      connection,
      c.req.param('space'),
      windowId,
      { ...pane, name: '' },
      command,
      authorized,
    )
    if (command.action === 'close') {
      const after = await runtimes.listResources(connection)
      if (
        after.status === 'online' &&
        !after.spaces.some((space) => space.windows.some((window) => window.id === windowId))
      )
        store.removeWindowReferences(connection, [windowId])
    }
    return c.json({ ok: true })
  })
  app.post('/api/sources/:id/spaces/:space/windows/:window/scan', async (c) => {
    z.object({})
      .strict()
      .parse(await c.req.json())
    const source = store.get<Source>('source', c.req.param('id'))
    if (!source || !options.windowContent) return c.json({ error: 'Window not found' }, 404)
    return c.json(
      await options.windowContent.scan(
        source,
        c.req.param('space'),
        c.req.param('window'),
        bearerToken(c.req.header('authorization')),
        c.req.raw.signal,
      ),
    )
  })
  app.post('/api/content-scans/:scan/items/:item/open', async (c) => {
    const context = z
      .object({
        canvasId: z.union([z.string().uuid(), z.literal('overview')]).optional(),
        anchorId: z.string().max(150).optional(),
        position: nodeLayoutSchema.pick({ x: true, y: true }).optional(),
      })
      .strict()
      .refine(
        (value) =>
          !value.position || (!!value.canvasId && value.canvasId !== 'overview' && !value.anchorId),
      )
      .parse(await c.req.json())
    const opened = await options.windowContent?.open(
      c.req.param('scan'),
      c.req.param('item'),
      bearerToken(c.req.header('authorization')),
      context,
      c.req.raw.signal,
    )
    return opened ? c.json(opened) : c.json({ error: 'Scan expired; scan this window again' }, 404)
  })
  app.on('POST', ['/api/files/:id/preview', '/api/downloads/:id/preview'], async (c) => {
    if (!options.previewFile)
      return c.json(
        { error: 'Original HTML preview unavailable', code: 'source-preview-unavailable' },
        404,
      )
    let publicBase: string
    try {
      const body = z
        .object({ apiBase: z.string().max(2048) })
        .strict()
        .parse(await c.req.json())
      const url = new URL(c.req.url)
      url.searchParams.set('apiBase', body.apiBase)
      publicBase = captureAddress(url, c.req.header('x-forwarded-prefix'))!
    } catch {
      return c.json({ error: 'Invalid Canvas API base', code: 'source-preview-invalid-base' }, 400)
    }
    try {
      return c.json(
        await options.previewFile(
          c.req.param('id')!,
          c.req.path.startsWith('/api/downloads/'),
          bearerToken(c.req.header('authorization')),
          publicBase,
        ),
      )
    } catch (error) {
      if (error instanceof SourcePreviewError)
        return c.json(
          { error: error.message, code: error.code },
          error.code === 'source-preview-unavailable' ? 404 : 502,
        )
      return c.json(
        { error: 'Could not start the original HTML preview', code: 'source-preview-start-failed' },
        502,
      )
    }
  })
  app.on(['GET', 'HEAD'], '/api/files/:id', async (c) => {
    const file = await loadFile(c.req.param('id'), c.req.query('download') === '1')
    if (!file) return c.json({ error: 'File not found' }, 404)
    const { body, headers } = file
    if (c.req.method === 'HEAD') {
      body.destroy()
      return c.newResponse(null, 200, headers)
    }
    return c.newResponse(Readable.toWeb(body) as ReadableStream, 200, headers)
  })
  app.post('/api/login', async (c) => {
    const input = z
      .object({ username: z.string().max(200), password: z.string().max(1024) })
      .parse(await c.req.json())
    const now = Date.now(),
      prior = attempts
    if (prior && prior.until > now && prior.count >= 10)
      return c.json({ error: 'Too many attempts. Try again in a minute.' }, 429)
    if (
      input.username !== account.username ||
      !verifyPassword(input.password, account.passwordHash)
    ) {
      attempts = {
        count: prior && prior.until > now ? prior.count + 1 : 1,
        until: prior && prior.until > now ? prior.until : now + 60_000,
      }
      return c.json({ error: 'Incorrect username or password' }, 401)
    }
    attempts = undefined
    const old = bearerToken(c.req.header('authorization'))
    if (old) store.removeSession(old)
    const token = randomBytes(32).toString('base64url')
    store.addSession(token)
    return c.json({
      authenticated: true,
      username: account.username,
      token,
      expiresAt: Date.now() + 7 * 86400_000,
      server: buildInfo,
    })
  })
  app.post('/api/logout', async (c) => {
    store.removeSession(bearerToken(c.req.header('authorization')))
    return c.json({ ok: true })
  })
  app.patch('/api/account', async (c) => {
    if (!options.updateAccount) return c.json({ error: 'Account settings unavailable' }, 503)
    const input = z
      .object({
        username: accountUsername,
        currentPassword: z.string().min(1).max(1024),
        password: accountPassword.optional(),
      })
      .strict()
      .parse(await c.req.json())
    const now = Date.now(),
      prior = attempts
    if (prior && prior.until > now && prior.count >= 10)
      return c.json({ error: 'Too many attempts. Try again in a minute.' }, 429)
    if (!verifyPassword(input.currentPassword, account.passwordHash)) {
      attempts = {
        count: prior && prior.until > now ? prior.count + 1 : 1,
        until: prior && prior.until > now ? prior.until : now + 60_000,
      }
      return c.json({ error: 'Current password is incorrect', code: 'incorrect-password' }, 403)
    }
    options.updateAccount(input.username, input.password)
    attempts = undefined
    if (input.password !== undefined)
      store.removeOtherSessions(bearerToken(c.req.header('authorization')))
    store.emit('account', account.username)
    return c.json({ username: account.username })
  })
  const source = (id: string) => {
    const result = store.get<Source>('source', id)
    if (!result) throw new Error('Source not found')
    return result
  }
  app.get('/api/state', (c) => c.json(store.snapshot()))
  app.post('/api/urls', async (c) => {
    const value = z
      .object({ sourceId: z.string().uuid(), url: z.string().max(8192) })
      .strict()
      .parse(await c.req.json())
    const opened = options.openUrl?.(
      source(value.sourceId),
      value.url,
      bearerToken(c.req.header('authorization')),
    )
    return opened ? c.json(opened) : c.json({ error: 'Web forwarding is unavailable' }, 503)
  })
  app.get('/api/settings', (c) => c.json(store.settings()))
  app.patch('/api/settings', async (c) =>
    c.json(store.updateSettings(settingsPatchSchema.parse(await c.req.json()))),
  )
  app.patch('/api/navigation-order/:kind', async (c) => {
    const kind = z.enum(['canvases', 'sources']).parse(c.req.param('kind'))
    const { ids } = z
      .object({ ids: z.array(z.string().min(1).max(200)).max(1000) })
      .strict()
      .parse(await c.req.json())
    return c.json(store.updateNavigationOrder(kind, ids))
  })
  app.get('/api/events', (c) => {
    const session = bearerToken(c.req.header('authorization'))
    const encoder = new TextEncoder()
    let controller: ReadableStreamDefaultController<Uint8Array>
    let pending: string | undefined
    const notificationQueue: string[] = []
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let notifications: { dispose(): void } | undefined
    let closed = false
    const flush = () => {
      if (!closed && (controller.desiredSize ?? 0) > 0) {
        const event = pending || notificationQueue.shift()
        if (event) {
          pending = undefined
          controller.enqueue(encoder.encode(event))
        }
      }
    }
    const close = (unauthorized = false) => {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      notifications?.dispose()
      notificationQueue.length = 0
      store.off('change', publish)
      store.off('sessions', checkSession)
      store.off('close', stopped)
      store.off('account', publishAccount)
      c.req.raw.signal.removeEventListener('abort', aborted)
      try {
        if (unauthorized) controller.enqueue(encoder.encode('event: unauthorized\ndata: {}\n\n'))
        controller.close()
      } catch {
        /* A disconnected reader is already closed. */
      }
    }
    const checkSession = () => {
      if (!store.hasSession(session)) {
        close(true)
        return false
      }
      return true
    }
    const publish = () => {
      if (closed || !checkSession()) return
      const snapshot = store.snapshot()
      // Keep only the latest snapshot when a browser is temporarily slow.
      pending = `event: state\nid: ${snapshot.instanceId}:${snapshot.revision}\ndata: ${JSON.stringify(snapshot)}\n\n`
      flush()
    }
    const stopped = () => close()
    const publishAccount = () => {
      if (!closed && checkSession())
        controller.enqueue(
          encoder.encode(
            `event: account\ndata: ${JSON.stringify({ username: account.username })}\n\n`,
          ),
        )
    }
    const publishNotification = (notification: CanvasNotification) => {
      if (closed || !checkSession() || !store.get<Source>('source', notification.sourceId)) return
      // Keep a small live burst, never a durable/reconnect notification history.
      if (notificationQueue.length === 32) notificationQueue.shift()
      notificationQueue.push(`event: notification\ndata: ${JSON.stringify(notification)}\n\n`)
      flush()
    }
    const aborted = () => close()
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value
        notifications = terminals.onNotification(publishNotification)
        store.on('change', publish)
        store.on('sessions', checkSession)
        store.on('close', stopped)
        store.on('account', publishAccount)
        c.req.raw.signal.addEventListener('abort', aborted, { once: true })
        if (c.req.raw.signal.aborted) {
          close()
          return
        }
        heartbeat = setInterval(() => {
          if (!closed && checkSession() && (controller.desiredSize ?? 0) > 0)
            controller.enqueue(encoder.encode(': keepalive\n\n'))
        }, 15_000)
        heartbeat.unref()
        publish()
      },
      pull: flush,
      cancel: () => close(),
    })
    c.header('Content-Type', 'text/event-stream')
    c.header('X-Accel-Buffering', 'no')
    c.header('Connection', 'keep-alive')
    return c.body(stream)
  })
  app.get('/api/resources', async (c) =>
    c.json({
      sources: await Promise.all(
        store.list<Source>('source').map(async (s) => {
          const resource = await runtimes.listResources(s)
          return options.completionReads?.projectResources(s, resource) || resource
        }),
      ),
    }),
  )
  app.post('/api/sources/probe', async (c) =>
    c.json(
      await runtimes.probeSource(sourceProbeSchema.parse(await c.req.json()), c.req.raw.signal),
    ),
  )
  app.post('/api/sources', async (c) => {
    const s = sourceSchema.parse(await c.req.json())
    if (s.id) return c.json({ error: 'ID is assigned by the server' }, 400)
    runtimes.validateSource({ ...s, id: s.id ?? 'new' })
    return c.json(store.put('source', s), 201)
  })
  app.patch('/api/sources/:id', async (c) => {
    const id = c.req.param('id')
    const patch = await c.req.json()
    const previous = source(id)
    const s = sourceSchema.parse({
      ...previous,
      ...patch,
      id,
    })
    runtimes.validateSource({ ...s, id })
    let updated = s
    if (sourceConnectionKey({ ...s, id }) !== sourceConnectionKey(previous)) {
      await terminals.closeSource(id, async () => {
        await options.closeOpenBridge?.(id)
        await runtimes.closeRuntimeConnections(id)
        // A name-only edit may have completed while the old connection closed.
        updated = store.put('source', sourceSchema.parse({ ...source(id), ...patch, id }))
      })
    } else updated = store.put('source', s)
    return c.json(updated)
  })
  app.delete('/api/sources/:id', async (c) => {
    const id = c.req.param('id')
    source(id)
    await terminals.closeSource(id, async () => {
      await options.closeOpenBridge?.(id)
      await runtimes.closeRuntimeConnections(id)
      store.remove('source', id)
    })
    return c.json({ ok: true })
  })
  app.post('/api/canvases', async (c) => {
    const value = canvasSchema.parse(await c.req.json())
    if (value.id) return c.json({ error: 'ID is assigned by the server' }, 400)
    return c.json(store.canvasView(store.put('canvas', value)), 201)
  })
  app.on(['PUT', 'PATCH'], '/api/canvases/:id', async (c) => {
    const id = c.req.param('id')
    if (id === 'overview') return c.json({ error: 'Overview is read-only' }, 403)
    const patch = await c.req.json()
    const canvas = store.get<Canvas>('canvas', id)
    if (!canvas) return c.json({ error: 'Canvas not found' }, 404)
    return c.json(
      store.canvasView(
        store.put(
          'canvas',
          canvasSchema.parse({
            ...canvas,
            ...patch,
            id,
          }),
        ),
      ),
    )
  })
  app.delete('/api/canvases/:id', (c) => {
    if (c.req.param('id') === 'overview') return c.json({ error: 'Overview is read-only' }, 403)
    store.remove('canvas', c.req.param('id'))
    return c.json({ ok: true })
  })
  app.post('/api/canvases/:id/nodes', async (c) => {
    const id = c.req.param('id')
    if (id === 'overview') return c.json({ error: 'Overview is read-only' }, 403)
    const { nodes } = nodeListSchema.parse(await c.req.json())
    const canvas = store.get<Canvas>('canvas', id)
    if (!canvas) return c.json({ error: 'Canvas not found' }, 404)
    for (const node of nodes)
      if (
        !canvas.nodes.some(
          (existing) =>
            existing.id === node.id ||
            (isTerminalNode(existing) &&
              isTerminalNode(node) &&
              existing.sourceId === node.sourceId &&
              existing.windowId === node.windowId),
        )
      )
        canvas.nodes.push(node)
    return c.json(store.canvasView(store.put('canvas', canvasSchema.parse(canvas))))
  })
  app.post('/api/canvases/:id/notes', async (c) => {
    const id = c.req.param('id')
    if (id === 'overview') return c.json({ error: 'Overview is read-only' }, 403)
    const value = noteCreateSchema.parse(await c.req.json())
    const canvas = store.get<Canvas>('canvas', id)
    if (!canvas) return c.json({ error: 'Canvas not found' }, 404)
    const note = {
      id: randomUUID(),
      type: 'note' as const,
      ...value,
    }
    canvas.nodes.push(note)
    return c.json(store.canvasView(store.put('canvas', canvasSchema.parse(canvas))), 201)
  })
  app.post('/api/canvases/:id/references', async (c) => {
    const id = c.req.param('id')
    const input = z
      .object({
        sourceCanvasId: z.string(),
        nodeId: nodeLayoutSchema.shape.id,
        x: nodeLayoutSchema.shape.x.default(80),
        y: nodeLayoutSchema.shape.y.default(80),
      })
      .strict()
      .parse(await c.req.json())
    if (id === 'overview' || input.sourceCanvasId === 'overview')
      return c.json({ error: 'Overview is read-only' }, 403)
    const sourceCanvas = store.get<Canvas>('canvas', input.sourceCanvasId)
    if (!sourceCanvas || !store.get<Canvas>('canvas', id))
      return c.json({ error: 'Canvas not found' }, 404)
    const node = sourceCanvas.nodes.find((item) => item.id === input.nodeId)
    if (!node || node.type === 'terminal') return c.json({ error: 'Shareable card not found' }, 404)
    const result = store.addNodeReference(input.sourceCanvasId, input.nodeId, id, {
      x: input.x,
      y: input.y,
    })
    return c.json(store.canvasView(result.canvas), result.added ? 201 : 200)
  })
  app.patch('/api/canvases/:id/notes/:node', async (c) => {
    const id = c.req.param('id'),
      nodeId = c.req.param('node'),
      mark = parseWriteMark(c.req.header('canvas-write')),
      resource = `note/${nodeId}`
    if (id === 'overview') return c.json({ error: 'Overview is read-only' }, 403)
    const patch = notePatchSchema.parse(await c.req.json())
    const canvas = store.get<Canvas>('canvas', id)
    if (!canvas) return c.json({ error: 'Canvas not found' }, 404)
    const node = canvas.nodes.find((item) => item.id === nodeId)
    if (!node || node.type !== 'note') return c.json({ error: 'Note not found' }, 404)
    const fields = Object.keys(patch) as (keyof typeof patch)[],
      fresh = order.fresh(mark, resource, fields)
    if (fields.length && !fresh.length) return c.json(store.canvasView(canvas))
    const updated = store.updateNote(id, nodeId, pick(patch, fresh))
    order.record(mark, resource, fresh)
    return c.json(store.canvasView(updated))
  })
  app.patch('/api/canvases/:id/layout', async (c) => {
    const id = c.req.param('id'),
      mark = parseWriteMark(c.req.header('canvas-write'))
    if (id === 'overview') return c.json({ error: 'Overview is read-only' }, 403)
    const { nodes } = layoutSchema.parse(await c.req.json())
    const cards = store.get<Canvas>('canvas', id)?.nodes ?? []
    // Every canvas showing a window shares its size, so that is ordered per window.
    const resource = (node: LayoutUpdate, field: LayoutField) => {
      const card = cards.find((item) => item.id === node.id)
      return card && isTerminalNode(card) && (field === 'width' || field === 'height')
        ? `window-size/${card.sourceId}/${card.windowId}`
        : `layout/${id}/${node.id}`
    }
    const fresh = nodes.flatMap((node): LayoutUpdate[] => {
      const fields = writtenFields(node).filter(
        (field) => order.fresh(mark, resource(node, field), [field]).length,
      )
      if (!fields.length) return []
      return [
        {
          id: node.id,
          ...pick(node, fields),
          ...(node.expected && { expected: pick(node.expected, fields) }),
        },
      ]
    })
    try {
      const canvas =
        nodes.length && !fresh.length
          ? store.get<Canvas>('canvas', id)
          : store.applyLayout(id, fresh)
      if (!canvas) return c.json({ error: 'Canvas not found' }, 404)
      for (const node of fresh)
        for (const field of writtenFields(node)) order.record(mark, resource(node, field), [field])
      return c.json(store.canvasView(canvas))
    } catch (error) {
      if (error instanceof LayoutConflict)
        return c.json({ error: 'Layout changed on another device', code: 'layout-conflict' }, 409)
      throw error
    }
  })
  app.delete('/api/canvases/:id/nodes/:node', (c) => {
    const id = c.req.param('id')
    if (id === 'overview') return c.json({ error: 'Overview is read-only' }, 403)
    const result = store.removeCard(
      id,
      c.req.param('node'),
      bearerToken(c.req.header('authorization')),
    )
    return result
      ? c.json({ ...result, canvas: store.canvasView(result.canvas) })
      : c.json({ error: 'Canvas not found' }, 404)
  })
  app.post('/api/canvases/:id/removals/:token/undo', async (c) => {
    z.object({})
      .strict()
      .parse(await c.req.json())
    const canvas = store.restoreCard(
      c.req.param('id'),
      c.req.param('token'),
      bearerToken(c.req.header('authorization')),
    )
    return canvas
      ? c.json(store.canvasView(canvas))
      : c.json({ error: 'Undo expired or unavailable' }, 404)
  })
  app.put('/api/canvases/:id/background', async (c) => {
    const id = c.req.param('id')
    if (!store.get<Canvas>('canvas', id)) return c.json({ error: 'Canvas not found' }, 404)
    const rawOpacity = c.req.query('opacity')
    const opacity =
      rawOpacity === undefined
        ? undefined
        : z.string().trim().min(1).transform(Number).pipe(opacitySchema).parse(rawOpacity)
    const image = await readBackground(c.req.raw)
    validateBackground(image, backgroundContentType(c.req.header('content-type')))
    // A canvas can be deleted while the upload is being read.
    const canvas = store.get<Canvas>('canvas', id)
    if (!canvas) return c.json({ error: 'Canvas not found' }, 404)
    store.setCanvasBackground(
      id,
      image,
      opacity ?? store.canvasView(canvas).background?.opacity ?? DEFAULT_BACKGROUND_OPACITY,
    )
    return c.json(store.canvasView(canvas))
  })
  app.patch('/api/canvases/:id/background', async (c) => {
    const id = c.req.param('id')
    const canvas = store.get<Canvas>('canvas', id)
    if (!canvas) return c.json({ error: 'Canvas not found' }, 404)
    const { opacity } = backgroundOpacitySchema.parse(await c.req.json())
    if (!store.canvasView(canvas).background) return c.json({ error: 'Background not found' }, 404)
    store.setCanvasBackgroundOpacity(id, opacity)
    return c.json(store.canvasView(canvas))
  })
  app.delete('/api/canvases/:id/background', (c) => {
    const id = c.req.param('id')
    const canvas = store.get<Canvas>('canvas', id)
    if (!canvas) return c.json({ error: 'Canvas not found' }, 404)
    store.removeCanvasBackground(id)
    return c.json(store.canvasView(canvas))
  })
  app.get('/api/backgrounds/:id', (c) => {
    const image = store.getBackground(c.req.param('id'))
    if (!image) return c.json({ error: 'Background not found' }, 404)
    c.header('Content-Type', storedBackgroundContentType(image))
    c.header('Content-Length', String(image.byteLength))
    c.header('Cross-Origin-Resource-Policy', 'same-origin')
    return c.body(image as Uint8Array<ArrayBuffer>)
  })
  app.post('/api/sources/:id/spaces', async (c) => {
    const { name, sourceSpaceId } = createSpaceSchema.parse(await c.req.json())
    return c.json(await runtimes.createSpace(source(c.req.param('id')), name, sourceSpaceId), 201)
  })
  app.patch('/api/sources/:id/spaces/:space', async (c) => {
    const { name } = nameSchema.parse(await c.req.json())
    await runtimes.renameSpace(source(c.req.param('id')), c.req.param('space'), name)
    return c.json({ ok: true })
  })
  app.delete('/api/sources/:id/spaces/:space', async (c) => {
    const connection = source(c.req.param('id'))
    const windows = await runtimes.closeSpace(connection, c.req.param('space'))
    store.removeWindowReferences(connection, windows)
    return c.json({ ok: true })
  })
  app.post('/api/sources/:id/spaces/:space/windows', async (c) => {
    const { name } = createWindowSchema.parse(await c.req.json())
    return c.json(
      await runtimes.createWindow(source(c.req.param('id')), c.req.param('space'), name),
      201,
    )
  })
  app.patch('/api/sources/:id/spaces/:space/windows/:window', async (c) => {
    const { name } = nameSchema.parse(await c.req.json())
    await runtimes.renameWindow(
      source(c.req.param('id')),
      c.req.param('space'),
      c.req.param('window'),
      name,
    )
    return c.json({ ok: true })
  })
  app.delete('/api/sources/:id/spaces/:space/windows/:window', async (c) => {
    const connection = source(c.req.param('id')),
      windowId = c.req.param('window')
    await runtimes.closeWindow(connection, c.req.param('space'), windowId)
    store.removeWindowReferences(connection, [windowId])
    return c.json({ ok: true })
  })
  app.onError((error, c) => {
    if (error instanceof BackgroundError) return c.json({ error: error.message }, error.status)
    if (error instanceof z.ZodError)
      return c.json(
        {
          error: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        },
        400,
      )
    return c.json({ error: error.message }, 400)
  })
  return app
}
