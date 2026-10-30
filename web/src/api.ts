import { t } from './i18n'

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  let body: any
  const text = await response.text()
  try { body = text ? JSON.parse(text) : undefined } catch { body = undefined }
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('canvas:unauthorized'))
    throw new ApiError(response.status, body?.error || body?.message || t('common.requestFailed', { status: response.status }))
  }
  return body as T
}
export function write<T = unknown>(path: string, method: string, body?: unknown): Promise<T> {
  return api<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) })
}
export function segment(value: string): string { return encodeURIComponent(value) }
export function uuid(): string {
  if (crypto.randomUUID) return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
