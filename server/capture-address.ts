import { normalizeCapturePublicBase } from './capture.ts'

/** The authenticated browser supplies its selected API base. Reverse proxies
 * may replace Host and terminate TLS, so transport headers cannot rebuild it.
 * This address is presentation metadata; the source target stays loopback.
 */
export function captureAddress(url: URL, forwardedPrefix: string | string[] | undefined): string | undefined {
  const bases = url.searchParams.getAll('apiBase')
  if (!bases.length) return
  if (bases.length !== 1) throw new Error('Ambiguous Canvas API base')
  const base = normalizeCapturePublicBase(bases[0])
  if (forwardedPrefix !== undefined && (typeof forwardedPrefix !== 'string' || !/^(?:\/[A-Za-z0-9_-]+)*\/?$/u.test(forwardedPrefix)))
    throw new Error('Invalid Canvas proxy prefix')
  const prefix = (forwardedPrefix || '').toString().replace(/\/$/u, '')
  if (new URL(base).pathname !== prefix + '/') throw new Error('Canvas API base does not match the proxy prefix')
  return base
}
