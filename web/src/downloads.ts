import { computed, shallowRef } from 'vue'
import { apiFetch, apiUrl } from './api'
import { downloadMedia } from './media'
import { filePreview, type FilePreview } from './file-preview'

export interface DownloadContext { canvasId?: string; anchorId?: string }
export interface DownloadResource { sourceId: string; windowId: string }
export interface DownloadPreview {
  id: string
  filename: string
  size: number
  mime?: string
  preview: Exclude<FilePreview, 'file'>
  url: string
}

const previews = shallowRef<DownloadPreview[]>([])
export const downloadPreview = computed(() => previews.value[0])
export const downloadPreviewCount = computed(() => previews.value.length)
export function dismissDownloadPreview() { previews.value = previews.value.slice(1) }

/** Present an already-staged file in the browser that requested it. */
export async function presentDownload(file: Omit<DownloadPreview, 'preview'>, download = false) {
  const preview = filePreview(file)
  if (!download && preview !== 'file') {
    previews.value = [...previews.value, { ...file, preview }]
    return
  }
  await downloadMedia(file.url, file.filename)
}

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
    await apiFetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(context), signal: controller.signal,
    })
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
  try { url = apiUrl(message.url) } catch { return true }
  if (url.href !== apiUrl(path).href || url.search) return true
  if (!firstMessage(socket, message.type, message.id)) return true
  if (Number.isSafeInteger(message.size) && (message.size as number) >= 0) {
    void presentDownload({ id: message.id, filename: message.filename,
      size: message.size as number, mime: typeof message.mime === 'string' ? message.mime : undefined, url: path }).catch(reportDownloadError)
    return true
  }
  void downloadMedia(url.href, message.filename).catch(reportDownloadError)
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

export function reportDownloadError(reason: unknown) {
  if (reason instanceof Error && reason.name === 'AbortError') return
  window.dispatchEvent(new CustomEvent('canvas:error', { detail: reason }))
}
