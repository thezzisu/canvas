// Files, media links, uploads and downloads.
import { isSystemCanvas } from '../../shared/system-canvases.ts'
import { Readable } from 'node:stream'
import { z } from 'zod'
import { bearerToken } from '../auth.ts'
import { MediaTickets, mediaPath, type DownloadResponse } from '../media.ts'
import { receiveCanvasFile } from '../canvas-files.ts'
import { captureAddress } from '../capture-address.ts'
import { SourcePreviewError } from '../source-preview.ts'
import type { RouteContext } from './context.ts'

export function fileRoutes({ app, store, options, origins }: RouteContext) {
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
    if (isSystemCanvas(id)) return c.json({ error: 'System canvases are read-only' }, 403)
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
}
