import { computed, shallowRef } from 'vue'

export interface DownloadContext { canvasId?: string; anchorId?: string }
export interface DownloadResource { sourceId: string; windowId: string }
export interface DownloadPreview {
  id: string
  filename: string
  size: number
  preview: 'image' | 'pdf' | 'text'
  url: string
}

const previews = shallowRef<DownloadPreview[]>([])
export const downloadPreview = computed(() => previews.value[0])
export const downloadPreviewCount = computed(() => previews.value.length)
export function dismissDownloadPreview() { previews.value = previews.value.slice(1) }

const requests = new Map<AbortController, WebSocket>()
let received = new WeakMap<WebSocket, Set<string>>()
let getDownloadContext: (resource: DownloadResource) => DownloadContext | undefined = () => undefined

export function setDownloadContext(getter?: (resource: DownloadResource) => DownloadContext | undefined) {
  getDownloadContext = getter || (() => undefined)
}

function firstMessage(socket: WebSocket, type: string, id: string) {
  const messages = received.get(socket) || new Set<string>()
  const key = `${type}:${id}`
  if (messages.has(key)) return false
  messages.add(key)
  if (messages.size > 256) messages.delete(messages.values().next().value!)
  received.set(socket, messages)
  return true
}

async function prepare(socket: WebSocket, path: string, context: DownloadContext) {
  const controller = new AbortController()
  requests.set(controller, socket)
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'prepare', ...context }), signal: controller.signal,
    })
    if (response.status === 401) window.dispatchEvent(new Event('canvas:unauthorized'))
  } catch {
    // The server expires an unprepared transfer and reports the failure to its
    // helper. No browser download is attempted before staging has completed.
  } finally {
    clearTimeout(timeout)
    requests.delete(controller)
  }
}

/** Bind staging to the receiving tab's canvas without a browser decision. */
export function receiveDownload(socket: WebSocket, message: Record<string, unknown>, resource: DownloadResource): boolean {
  if (message.type !== 'file-context' && message.type !== 'download') return false
  if (typeof message.id !== 'string' || !message.id || message.id.length > 256) return true
  let path: string
  try { path = `/api/downloads/${encodeURIComponent(message.id)}` } catch { return true }
  if (message.type === 'file-context') {
    if (!firstMessage(socket, message.type, message.id)) return true
    const context = { ...getDownloadContext(resource) }
    void prepare(socket, path, context)
    return true
  }
  if (typeof message.url !== 'string' || typeof message.filename !== 'string') return true
  let url: URL
  try { url = new URL(message.url, location.href) } catch { return true }
  if (url.origin !== location.origin || url.pathname !== path || url.search || url.hash) return true
  if (!firstMessage(socket, message.type, message.id)) return true
  if ((message.preview === 'image' || message.preview === 'pdf' || message.preview === 'text')
      && Number.isSafeInteger(message.size) && (message.size as number) >= 0) {
    previews.value = [...previews.value, { id: message.id, filename: message.filename,
      size: message.size as number, preview: message.preview, url: path }]
    return true
  }
  // This URL serves an already-staged file. Browser download policy can no
  // longer hold the remote helper or its terminal session open.
  const anchor = document.createElement('a')
  anchor.href = url.href
  anchor.download = message.filename
  anchor.hidden = true
  const target = document.fullscreenElement || document.body
  target.append(anchor)
  anchor.click()
  anchor.remove()
  return true
}

export function disconnectDownloads(socket: WebSocket) {
  for (const [controller, owner] of requests) {
    if (owner === socket) { controller.abort(); requests.delete(controller) }
  }
  received.delete(socket)
}

export function clearDownloads() {
  for (const controller of requests.keys()) controller.abort()
  requests.clear()
  received = new WeakMap()
  previews.value = []
}
