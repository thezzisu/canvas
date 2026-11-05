import { shallowReactive } from 'vue'
import { apiUrl } from './api'
import { discardFrames } from './retained-frame'

/** Whether a capture exists is shared server state; showing it is local to this browser. */
export interface CapturedApp { id: string; url: string; title: string; paneId: string; visible: boolean; preview?: 'static' }
interface Capture { id: string; url: string; title: string; paneId: string; preview?: 'static' }
const captures = shallowReactive(new Map<string, Capture>())
// Per browser and capture: every card for this window shows the same view.
const hidden = shallowReactive(new Set<string>())
const key = (sourceId: string, windowId: string) => `${sourceId}/${windowId}`
const viewKey = (id: string) => 'canvas:capture-hidden:' + id
function readHidden(id: string) { try { return localStorage.getItem(viewKey(id)) === '1' } catch { return false } }

export function capturedApp(sourceId: string, windowId: string): CapturedApp | undefined {
  const capture = captures.get(key(sourceId, windowId))
  return capture && { ...capture, visible: !hidden.has(capture.id) }
}
export function setCaptureVisible(sourceId: string, windowId: string, visible: boolean) {
  const capture = captures.get(key(sourceId, windowId))
  if (!capture || visible === !hidden.has(capture.id)) return
  if (visible) hidden.delete(capture.id); else hidden.add(capture.id)
  try { if (visible) localStorage.removeItem(viewKey(capture.id)); else localStorage.setItem(viewKey(capture.id), '1') } catch { /* Optional. */ }
}
function forget(entry: string) {
  const capture = captures.get(entry)
  if (!capture) return
  captures.delete(entry); hidden.delete(capture.id); discardFrames(`capture:${capture.id}`)
  try { localStorage.removeItem(viewKey(capture.id)) } catch { /* Optional. */ }
}
export function receiveCapture(sourceId: string, windowId: string, message: Record<string, unknown>): boolean {
  if (message.type === 'capture-ended') {
    if (captures.get(key(sourceId, windowId))?.id === message.id) forget(key(sourceId, windowId))
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
    const entry = key(sourceId, windowId), previous = captures.get(entry)
    if (previous?.id === message.id && previous.url === url.href) return true
    if (previous && previous.id !== message.id) forget(entry)
    if (readHidden(message.id)) hidden.add(message.id)
    captures.set(entry, { id: message.id, url: url.href, title: message.title.slice(0, 120), paneId: message.paneId,
      ...(message.preview === 'static' ? { preview: 'static' } : {}) })
  } catch { /* Invalid capture messages never become iframe addresses. */ }
  return true
}
/** Account or instance changes end every session-scoped frame, including PDF viewers. */
export function clearCaptures() { captures.clear(); hidden.clear(); discardFrames() }
export function removeCaptures(sourceId: string, windowId?: string) {
  if (windowId !== undefined) { forget(key(sourceId, windowId)); return }
  for (const entry of [...captures.keys()]) if (entry.startsWith(sourceId + '/')) forget(entry)
}
