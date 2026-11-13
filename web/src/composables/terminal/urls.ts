import type { TerminalConnection } from '../../utils/terminal/terminal-channels'
import { computed, shallowRef } from 'vue'
import { api, apiUrl, requireCurrentApi, uuid, type ApiContext } from '../../api/api'

interface UrlRequest {
  id: string
  url: string
  forwarded: boolean
}
const requests = shallowRef<UrlRequest[]>([])
let received = new WeakMap<TerminalConnection, Set<string>>()
export const urlRequest = computed(() => requests.value[0])
export function dismissUrl() {
  requests.value = requests.value.slice(1)
}
export function presentUrl(value: UrlRequest) {
  let url: URL
  try {
    if (value.forwarded) {
      const relative = new URL(value.url, 'http://canvas.invalid')
      url = apiUrl(relative.pathname + relative.search)
      url.hash = relative.hash
    } else url = new URL(value.url)
  } catch {
    return
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return
  if (value.forwarded && !/^\/api\/forward\/[A-Za-z0-9_-]{43}\//u.test(value.url)) return
  requests.value = [...requests.value, { ...value, url: url.href }]
}
export function receiveUrl(
  connection: TerminalConnection,
  message: Record<string, unknown>,
): boolean {
  if (message.type !== 'open-url') return false
  if (
    typeof message.id !== 'string' ||
    !message.id ||
    message.id.length > 256 ||
    typeof message.url !== 'string' ||
    typeof message.forwarded !== 'boolean'
  )
    return true
  const ids = received.get(connection) || new Set<string>()
  if (!ids.has(message.id)) {
    presentUrl({ id: message.id, url: message.url, forwarded: message.forwarded })
    ids.add(message.id)
    if (ids.size > 256) ids.delete(ids.values().next().value!)
    received.set(connection, ids)
  }
  connection.send({ type: 'url-received', id: message.id })
  return true
}
export function clearUrls() {
  requests.value = []
  received = new WeakMap()
}
/** Source-local web services go through the scoped forward and its confirmation dialog. */
export function forwardSourceUrl(
  sourceId: string,
  url: string,
  context: ApiContext,
  signal?: AbortSignal,
) {
  return api<{ url: string; forwarded: boolean }>(
    '/api/urls',
    { method: 'POST', body: JSON.stringify({ sourceId, url }), signal },
    context,
  )
}
export async function presentSourceUrl(sourceId: string, url: string, context: ApiContext) {
  const opened = await forwardSourceUrl(sourceId, url, context)
  requireCurrentApi(context)
  presentUrl({ id: uuid(), ...opened })
}
