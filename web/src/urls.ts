import { computed, shallowRef } from 'vue'
import { apiUrl } from './api'

interface UrlRequest { id: string; url: string; forwarded: boolean }
const requests = shallowRef<UrlRequest[]>([])
let received = new WeakMap<WebSocket, Set<string>>()
export const urlRequest = computed(() => requests.value[0])
export function dismissUrl() { requests.value = requests.value.slice(1) }
export function presentUrl(value: UrlRequest) {
  let url: URL
  try {
    if (value.forwarded) {
      const relative = new URL(value.url, 'http://canvas.invalid')
      url = apiUrl(relative.pathname + relative.search); url.hash = relative.hash
    } else url = new URL(value.url)
  } catch { return }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return
  if (value.forwarded && !/^\/api\/forward\/[A-Za-z0-9_-]{43}\//u.test(value.url)) return
  requests.value = [...requests.value, { ...value, url: url.href }]
}
export function receiveUrl(socket: WebSocket, message: Record<string, unknown>): boolean {
  if (message.type !== 'open-url') return false
  if (typeof message.id !== 'string' || !message.id || message.id.length > 256 || typeof message.url !== 'string' || typeof message.forwarded !== 'boolean') return true
  const ids = received.get(socket) || new Set<string>()
  if (!ids.has(message.id)) {
    presentUrl({ id: message.id, url: message.url, forwarded: message.forwarded })
    ids.add(message.id)
    if (ids.size > 256) ids.delete(ids.values().next().value!)
    received.set(socket, ids)
  }
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'url-received', id: message.id }))
  return true
}
export function clearUrls() { requests.value = []; received = new WeakMap() }
