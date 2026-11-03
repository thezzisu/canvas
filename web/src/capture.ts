import { shallowReactive } from 'vue'
import { apiUrl } from './api'

export interface CapturedApp { id: string; url: string; title: string; paneId: string; visible: boolean }
const captures = shallowReactive(new Map<string, CapturedApp>())
const key = (sourceId: string, windowId: string) => `${sourceId}/${windowId}`
export function capturedApp(sourceId: string, windowId: string): CapturedApp | undefined { return captures.get(key(sourceId, windowId)) }
export function setCaptureVisible(sourceId: string, windowId: string, visible: boolean) {
  const current = capturedApp(sourceId, windowId)
  if (current && current.visible !== visible) captures.set(key(sourceId, windowId), { ...current, visible })
}
export function receiveCapture(sourceId: string, windowId: string, message: Record<string, unknown>): boolean {
  if (message.type === 'capture-ended') {
    if (captures.get(key(sourceId, windowId))?.id === message.id) captures.delete(key(sourceId, windowId))
    return true
  }
  if (message.type !== 'capture') return false
  if (typeof message.id !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(message.id)
    || typeof message.url !== 'string' || typeof message.paneId !== 'string' || typeof message.title !== 'string'
    || message.windowId !== windowId) return true
  try {
    const expected = apiUrl(`/api/capture/${message.id}/`)
    const url = new URL(message.url, expected)
    if (url.origin !== expected.origin || !url.pathname.startsWith(expected.pathname)
      || url.username || url.password || !['http:', 'https:'].includes(url.protocol)) return true
    const previous = capturedApp(sourceId, windowId)
    captures.set(key(sourceId, windowId), { id: message.id, url: url.href, title: message.title.slice(0, 120), paneId: message.paneId,
      visible: previous?.id === message.id ? previous.visible : true })
  } catch { /* Invalid capture messages never become iframe addresses. */ }
  return true
}
export function clearCaptures() { captures.clear() }
export function removeCaptures(sourceId: string, windowId?: string) {
  if (windowId !== undefined) { captures.delete(key(sourceId, windowId)); return }
  for (const entry of captures.keys()) if (entry.startsWith(sourceId + '/')) captures.delete(entry)
}
