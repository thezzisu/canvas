import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import type { DownloadResponse } from './app.ts'

interface MediaTicket { path: string; download: boolean; session: string; expiresAt: number }
export type ReadMedia = (path: string, session: string, download: boolean) => Promise<DownloadResponse | undefined>
const lifetime = 10 * 60_000
export const mediaPath = /^\/api\/(?:files|downloads|backgrounds)\/[A-Za-z0-9_-]{1,150}$/u

export class MediaTickets {
  private tickets = new Map<string, MediaTicket>()
  constructor(private validSession: (session: string) => boolean, private read: ReadMedia,
    private origins: ReadonlySet<string>, private now = Date.now) {}

  async create(path: string, session: string, download = false) {
    if (!mediaPath.test(path) || !this.validSession(session)) return
    const media = await this.read(path, session, download)
    if (!media) return
    media.body.destroy()
    if (!this.validSession(session)) return
    const now = this.now()
    for (const [id, ticket] of this.tickets) if (ticket.expiresAt <= now || !this.validSession(ticket.session)) this.tickets.delete(id)
    if (this.tickets.size >= 2048) this.tickets.delete(this.tickets.keys().next().value!)
    const id = randomBytes(32).toString('base64url'), expiresAt = now + lifetime
    this.tickets.set(id, { path, session, download, expiresAt })
    return { url: `/api/media/${id}`, expiresAt }
  }

  async open(id: string, method: string, range?: string): Promise<Response | undefined> {
    const ticket = this.tickets.get(id)
    if (!ticket) return
    if (ticket.expiresAt <= this.now() || !this.validSession(ticket.session)) { this.tickets.delete(id); return }
    const media = await this.read(ticket.path, ticket.session, ticket.download)
    if (!media) return
    if (ticket.expiresAt <= this.now() || !this.validSession(ticket.session)) { media.body.destroy(); return }
    const headers = new Headers(media.headers)
    headers.set('Cache-Control', 'private, no-store')
    headers.set('Referrer-Policy', 'no-referrer')
    headers.set('X-Content-Type-Options', 'nosniff')
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin')
    const pdf = headers.get('Content-Type')?.split(';')[0] === 'application/pdf'
    headers.set('Content-Security-Policy', `default-src 'none'; ${pdf ? '' : 'sandbox; '}frame-ancestors 'self' ${[...this.origins].join(' ')}`.trim())
    headers.delete('X-Frame-Options')
    const length = headers.get('Content-Length')
    const size = length === null ? NaN : Number(length)
    if (!Number.isSafeInteger(size) || size < 0) { media.body.destroy(); throw new Error('Invalid media length') }
    headers.set('Accept-Ranges', 'bytes')
    let start = 0, end = size - 1, status = 200
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/u.exec(range)
      if (match && (match[1] || match[2])) {
        start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
        end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1
      } else start = size
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
        media.body.destroy(); headers.set('Content-Range', `bytes */${size}`); headers.delete('Content-Length')
        return new Response(null, { status: 416, headers })
      }
      status = 206
      headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
      headers.set('Content-Length', String(end - start + 1))
    }
    if (method === 'HEAD') { media.body.destroy(); return new Response(null, { status, headers }) }
    if (range && media.readRange) {
      media.body.destroy()
      const body = await media.readRange(start, end)
      if (!body) return
      if (ticket.expiresAt <= this.now() || !this.validSession(ticket.session)) { body.destroy(); return }
      return new Response(Readable.toWeb(body) as ReadableStream, { status, headers })
    }
    const source = media.body
    async function* bytes() {
      let position = 0
      try {
        for await (const chunk of source) {
          const buffer = Buffer.from(chunk), next = position + buffer.length
          if (next > start && position <= end) yield buffer.subarray(Math.max(0, start - position), Math.min(buffer.length, end + 1 - position))
          position = next
          if (position > end) break
        }
      } finally { source.destroy() }
    }
    const body = range ? Readable.from(bytes()) : source
    return new Response(Readable.toWeb(body) as ReadableStream, { status, headers })
  }
}
