import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import type { MiddlewareHandler } from 'hono'
import { getMimeType } from 'hono/utils/mime'

const hashedAsset = /^\/assets\/[^/]+-[\w-]{8,}\.(?:js|css|woff2)$/

/** Public build output only. API routes keep their own authentication and cache policy. */
export function serveCanvasStatic(directory: string): MiddlewareHandler {
  const root = resolve(directory)
  return async (c, next) => {
    if (!['GET', 'HEAD'].includes(c.req.method) || /^\/api(?:\/|$)/.test(c.req.path)) return next()
    let pathname: string
    try { pathname = decodeURIComponent(c.req.path) } catch { return c.notFound() }
    if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(part => part === '.' || part === '..')) return c.notFound()
    const file = join(root, pathname === '/' ? 'index.html' : pathname)
    const info = await stat(file).catch(() => undefined)
    if (!info?.isFile()) return c.notFound()

    const etag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`
    c.header('Cache-Control', hashedAsset.test(pathname) ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate')
    c.header('ETag', etag)
    c.header('Last-Modified', info.mtime.toUTCString())
    c.header('X-Content-Type-Options', 'nosniff')
    const match = c.req.header('If-None-Match')
    const modified = c.req.header('If-Modified-Since')
    const notModified = match !== undefined
      ? match.split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag.slice(2))
      : modified !== undefined && Math.floor(info.mtimeMs / 1000) * 1000 <= Date.parse(modified)
    if (notModified) return c.body(null, 304)

    c.header('Content-Type', getMimeType(file) || 'application/octet-stream')
    c.header('Content-Length', String(info.size))
    if (c.req.method === 'HEAD') return c.body(null, 200)
    return c.body(Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>, 200)
  }
}
