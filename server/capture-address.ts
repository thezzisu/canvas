import type { IncomingMessage } from 'node:http'

/** Canonical presentation URL only; this value never selects the source target. */
export function normalizeCapturePublicBase(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\?#]/u.test(value)) throw new Error('Capture public base must be a canonical HTTP(S) API base')
  let url: URL
  try { url = new URL(value) } catch { throw new Error('Capture public base must be a canonical HTTP(S) API base') }
  const canonical = value.endsWith('/') ? value : value + '/'
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || (url.href !== canonical && url.href + '/' !== canonical)
    || (url.pathname !== '/' && !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\/?$/u.test(url.pathname)))
    throw new Error('Capture public base must be a canonical HTTP(S) API base')
  return canonical
}

function proxyPrefix(value: string | string[] | undefined): string {
  if (value !== undefined && (typeof value !== 'string' || !/^(?:\/[A-Za-z0-9_-]+)*\/?$/u.test(value)))
    throw new Error('Invalid Canvas proxy prefix')
  return (value || '').toString().replace(/\/$/u, '')
}

/** Ingress must preserve Host or overwrite X-Forwarded-Host, plus protocol and prefix. */
export function captureRequestBase(request: IncomingMessage): URL {
  const host = request.headers['x-forwarded-host'] ?? request.headers.host
  const protocol = request.headers['x-forwarded-proto'] ?? ('encrypted' in request.socket && request.socket.encrypted ? 'https' : 'http')
  if (typeof host !== 'string' || !host || /[,\s/\\?#@]/u.test(host) || !['http', 'https'].includes(String(protocol)) || Array.isArray(protocol))
    throw new Error('Invalid Canvas proxy authority')
  return new URL(normalizeCapturePublicBase(`${protocol}://${host}${proxyPrefix(request.headers['x-forwarded-prefix'])}/`))
}

/** The authenticated browser supplies the startup command's selected API base.
 * Later proxy requests use their own ingress headers through captureRequestBase.
 * Both addresses are presentation metadata; the source target stays loopback.
 */
export function captureAddress(url: URL, forwardedPrefix: string | string[] | undefined): string | undefined {
  const bases = url.searchParams.getAll('apiBase')
  if (!bases.length) return
  if (bases.length !== 1) throw new Error('Ambiguous Canvas API base')
  const base = normalizeCapturePublicBase(bases[0])
  const prefix = proxyPrefix(forwardedPrefix)
  if (new URL(base).pathname !== prefix + '/') throw new Error('Canvas API base does not match the proxy prefix')
  return base
}
