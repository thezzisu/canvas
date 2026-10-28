import { shallowRef } from 'vue'

export type DownloadState = 'offered' | 'accepted' | 'transferring' | 'completed' | 'cancelled' | 'failed'
export interface Download {
  id: string
  url: string
  filename: string
  size: number
  transferred: number
  state: DownloadState
  reason?: string
  cancelling?: boolean
  context: DownloadContext
}
export interface DownloadContext { canvasId?: string; anchorId?: string }
export interface DownloadResource { sourceId: string; windowId: string }

export const downloads = shallowRef<Download[]>([])
const owners = new Map<string, WebSocket>()
const dismissTimers = new Map<string, ReturnType<typeof setTimeout>>()
const requests = new Set<AbortController>()
let getDownloadContext: (resource: DownloadResource) => DownloadContext | undefined = () => undefined
const terminalStates = new Set<DownloadState>(['completed', 'cancelled', 'failed'])
const states = new Set<DownloadState>(['offered', 'accepted', 'transferring', ...terminalStates])
export const downloadFinished = (download: Download) => terminalStates.has(download.state)
export function setDownloadContext(getter?: (resource: DownloadResource) => DownloadContext | undefined) {
  getDownloadContext = getter || (() => undefined)
}

function find(id: string) { return downloads.value.find(download => download.id === id) }
function update(id: string, patch: Partial<Download>) {
  downloads.value = downloads.value.map(download => download.id === id ? { ...download, ...patch } : download)
}
export function dismissDownload(id: string) {
  clearTimeout(dismissTimers.get(id))
  dismissTimers.delete(id)
  owners.delete(id)
  downloads.value = downloads.value.filter(download => download.id !== id)
}
function finish(id: string) {
  const download = find(id)
  if (!download || !downloadFinished(download)) return
  owners.delete(id)
  clearTimeout(dismissTimers.get(id))
  dismissTimers.set(id, setTimeout(() => dismissDownload(id), download.state === 'failed' ? 10_000 : 6_000))
  const finished = downloads.value.filter(downloadFinished)
  for (const stale of finished.slice(0, Math.max(0, finished.length - 3))) dismissDownload(stale.id)
}
function progress(id: string, message: Record<string, unknown>) {
  const download = find(id)
  if (!download || downloadFinished(download) || !states.has(message.state as DownloadState)) return
  const state = message.state as DownloadState
  // Acceptance is optimistic so a second click cannot start a second GET.
  if (state === 'offered' && download.state !== 'offered') return
  if (state === 'accepted' && download.state === 'transferring') return
  update(id, {
    state,
    transferred: typeof message.transferred === 'number' && Number.isSafeInteger(message.transferred)
      ? Math.max(download.transferred, Math.min(download.size, message.transferred)) : download.transferred,
    reason: typeof message.reason === 'string' ? message.reason : undefined,
    ...(terminalStates.has(state) ? { cancelling: false } : {}),
  })
  finish(id)
}

/** Download offers belong to the exact terminal socket that received them. */
export function receiveDownload(socket: WebSocket, message: Record<string, unknown>, resource: DownloadResource): boolean {
  if (message.type !== 'download' && message.type !== 'download-progress') return false
  if (typeof message.id !== 'string') return true
  if (message.type === 'download-progress') {
    if (owners.get(message.id) === socket) progress(message.id, message)
    return true
  }
  if (find(message.id) || typeof message.url !== 'string' || typeof message.filename !== 'string'
      || typeof message.size !== 'number' || !Number.isSafeInteger(message.size) || message.size < 0) return true
  let url: URL
  try { url = new URL(message.url, location.href) } catch { return true }
  const path = `/api/downloads/${encodeURIComponent(message.id)}`
  if (url.origin !== location.origin || url.pathname !== path || url.search || url.hash) return true
  const context = { ...getDownloadContext(resource) }
  const href = new URL(path, location.href)
  if (context.canvasId) href.searchParams.set('canvasId', context.canvasId)
  if (context.anchorId) href.searchParams.set('anchorId', context.anchorId)
  owners.set(message.id, socket)
  downloads.value = [...downloads.value, { id: message.id, url: `${href.pathname}${href.search}`, filename: message.filename,
    size: message.size, transferred: 0, state: 'offered', context }]
  return true
}

async function action(id: string, action: 'accept' | 'cancel') {
  const download = find(id)
  if (!download) return
  const controller = new AbortController()
  requests.add(controller)
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch(download.url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...download.context }), signal: controller.signal,
    })
    if (response.status === 401) window.dispatchEvent(new Event('canvas:unauthorized'))
    if (response.status === 404 && action === 'cancel') {
      progress(id, { state: 'cancelled' })
      return
    }
    if (!response.ok) throw new Error('Download action failed')
    const result: Record<string, unknown> | undefined = response.status === 204 ? undefined : await response.json()
    if (result?.state) progress(id, result)
    else if (action === 'cancel') progress(id, { state: 'cancelled' })
  } catch {
    const current = find(id)
    if (!current || downloadFinished(current)) return
    // The GET may already be transferring even if its acceptance POST failed.
    if (action === 'accept') return
    update(id, { state: 'failed', reason: 'disconnected', cancelling: false })
    finish(id)
  } finally {
    clearTimeout(timeout)
    requests.delete(controller)
  }
}

/** Called by a real download link click; never await before its default action. */
export function acceptDownload(id: string): boolean {
  const download = find(id)
  if (!download || download.state !== 'offered' || download.cancelling) return false
  update(id, { state: 'accepted' })
  void action(id, 'accept')
  return true
}
export function cancelDownload(id: string) {
  const download = find(id)
  if (!download || downloadFinished(download) || download.cancelling) return
  update(id, { cancelling: true })
  void action(id, 'cancel')
}
export function disconnectDownloads(socket: WebSocket) {
  for (const [id, owner] of owners) {
    if (owner !== socket) continue
    update(id, { state: 'failed', reason: 'disconnected', cancelling: false })
    finish(id)
  }
}
export function clearDownloads() {
  for (const controller of requests) controller.abort()
  requests.clear()
  for (const timer of dismissTimers.values()) clearTimeout(timer)
  dismissTimers.clear()
  owners.clear()
  downloads.value = []
}
