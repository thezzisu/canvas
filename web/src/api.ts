import { ref, watch } from 'vue'
import { t } from './i18n'
import { activeInstance } from './instances'
import { resolveApiUrl } from './instance-url'
import { sessionToken, storeSessionToken, tokenKey } from './instance-session'

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

export interface ApiContext { id: string; base: string; token: string; revision: number; signal: AbortSignal }
export const apiRevision = ref(0)
let lifetime = new AbortController()
export function resetApiRequests() {
  lifetime.abort(); lifetime = new AbortController(); apiRevision.value++
}
watch(() => `${activeInstance.value.id}:${activeInstance.value.base}`, resetApiRequests, { flush: 'sync' })
window.addEventListener('storage', event => {
  if (event.storageArea !== localStorage || event.key !== null && (event.key !== tokenKey(activeInstance.value.id) || event.oldValue === event.newValue)) return
  resetApiRequests()
  window.dispatchEvent(new Event('canvas:session-changed'))
})
export function apiContext(): ApiContext {
  const instance = activeInstance.value
  return { id: instance.id, base: instance.base, token: sessionToken(instance), revision: apiRevision.value, signal: lifetime.signal }
}
export function isCurrentApi(context: ApiContext) { return context.revision === apiRevision.value && !context.signal.aborted }
export function requireCurrentApi(context: ApiContext) {
  if (!isCurrentApi(context)) throw new DOMException('Canvas instance changed', 'AbortError')
}
export function setSessionToken(token: string) {
  storeSessionToken(activeInstance.value, token)
  resetApiRequests()
}
export function apiUrl(path: string, context = apiContext()) { return resolveApiUrl(context.base, path) }
export async function apiFetch(path: string, init?: RequestInit, context = apiContext()): Promise<Response> {
  requireCurrentApi(context)
  const headers = new Headers(init?.headers)
  if (context.token) headers.set('Authorization', `Bearer ${context.token}`)
  const signal = init?.signal ? AbortSignal.any([context.signal, init.signal]) : context.signal
  const response = await fetch(apiUrl(path, context), { ...init, headers, credentials: 'omit', signal })
  requireCurrentApi(context)
  if (response.status === 401 && context.token) window.dispatchEvent(new Event('canvas:unauthorized'))
  return response
}
export async function api<T = unknown>(path: string, init?: RequestInit, context = apiContext()): Promise<T> {
  const headers = new Headers(init?.headers)
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const response = await apiFetch(path, { ...init, headers }, context)
  let body: any
  const text = await response.text()
  requireCurrentApi(context)
  try { body = text ? JSON.parse(text) : undefined } catch { body = undefined }
  if (!response.ok) {
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
