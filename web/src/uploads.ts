import { t } from './i18n'
import { apiContext, apiFetch, apiUrl, uuid, type ApiContext } from './api'
import { hasFileTransfer, readFileTransfer } from './browser-file-input'

export interface TerminalUploadState {
  id?: string
  name: string
  fileCount?: number
  transferred: number
  total: number
  state: 'preparing' | 'uploading' | 'completed' | 'cancelled' | 'failed'
  error?: string
  queued?: number
  cancelling?: boolean
  rejected?: string
}
interface Batch { context: ApiContext; id: string; files: File[]; total: number; request?: AbortController; running: boolean; cancelling?: boolean }
interface UploadOptions {
  available(): boolean
  focus(): void
  send(message: unknown): boolean
  changed(state: TerminalUploadState | undefined): void
}

/** A queue belongs to the native window, independently of its current card. */
export class TerminalUploads {
  private pending: Batch[] = []
  private current?: Batch
  private state?: TerminalUploadState
  private timer?: ReturnType<typeof setTimeout>
  private dismissed?: ReturnType<typeof setTimeout>
  constructor(private readonly options: UploadOptions) {}

  private update(patch: Partial<TerminalUploadState>) {
    if (!this.state) return
    this.state = { ...this.state, ...patch, queued: this.pending.length }
    this.options.changed(this.state)
  }

  reject(error: string) {
    if (this.current) { this.update({ rejected: error }); return }
    clearTimeout(this.dismissed)
    this.state = { name: '', transferred: 0, total: 0, state: 'failed', error }
    this.options.changed(this.state)
    this.dismissed = setTimeout(() => { this.state = undefined; this.options.changed(undefined) }, 6000)
  }

  enqueue(files: File[]) {
    if (!files.length) return
    if (!this.options.available()) { this.reject(t('terminal.upload.disconnected')); return }
    if (files.some(file => file.webkitRelativePath)) { this.reject(t('terminal.upload.foldersUnsupported')); return }
    if (this.current?.cancelling) return
    const total = files.reduce((sum, file) => sum + file.size, 0)
    if (!Number.isSafeInteger(total)) { this.reject(t('terminal.upload.invalidSize')); return }
    this.options.focus()
    this.pending.push({ context: apiContext(), id: uuid(), files, total, running: false })
    if (this.current) this.update({ rejected: undefined })
    else this.next()
  }

  private next() {
    clearTimeout(this.dismissed)
    const batch = this.current = this.pending.shift()
    if (!batch) return
    this.state = { id: batch.id, name: batch.files.length === 1 ? batch.files[0]!.name : '', fileCount: batch.files.length,
      transferred: 0, total: batch.total, state: 'preparing', queued: this.pending.length }
    this.options.changed(this.state)
    if (!this.options.send({ type: 'upload-begin', id: batch.id, files: batch.files.map(file => ({ name: file.name, size: file.size })) })) {
      this.finish('failed', t('terminal.connection.interrupted'))
      return
    }
    this.timer = setTimeout(() => {
      this.options.send({ type: 'upload-cancel', id: batch.id })
      this.finish('failed', t('terminal.upload.prepareTimeout'))
    }, 30_000)
  }

  receive(message: Record<string, unknown>): boolean {
    if (message.type !== 'upload-ready' && message.type !== 'upload-progress') return false
    const batch = this.current
    if (!batch || message.id !== batch.id) return true
    if (message.type === 'upload-ready') {
      if (batch.cancelling) { this.options.send({ type: 'upload-cancel', id: batch.id }); return true }
      if (batch.running) return true
      if (!Array.isArray(message.urls) || message.urls.length !== batch.files.length || !message.urls.every(value => typeof value === 'string')) {
        this.options.send({ type: 'upload-cancel', id: batch.id })
        this.finish('failed', t('terminal.upload.invalidUrl'))
        return true
      }
      const urls: string[] = []
      try {
        for (const value of message.urls as string[]) {
          const url = apiUrl(value, batch.context)
          if (!url.pathname.startsWith(`${new URL(batch.context.base).pathname}api/uploads/`) || url.search) throw new Error('Invalid upload URL')
          urls.push(url.href)
        }
      } catch {
        this.options.send({ type: 'upload-cancel', id: batch.id })
        this.finish('failed', t('terminal.upload.invalidUrl'))
        return true
      }
      clearTimeout(this.timer)
      batch.running = true
      this.update({ state: 'uploading' })
      void this.put(batch, urls)
      return true
    }
    if (typeof message.transferred === 'number' && Number.isSafeInteger(message.transferred)) {
      this.update({ transferred: Math.max(this.state?.transferred || 0, Math.min(batch.total, message.transferred)) })
    }
    if (message.state === 'completed') this.finish('completed')
    else if (message.state === 'cancelled') this.finish('cancelled')
    else if (message.state === 'failed') {
      const error = typeof message.error === 'string' ? message.error : t('terminal.upload.failed')
      this.finish('failed', typeof message.failedFile === 'string' ? t('terminal.upload.fileFailed', { name: message.failedFile, error }) : error)
    }
    else if (message.state === 'uploading') this.update({ state: 'uploading' })
    return true
  }

  private async put(batch: Batch, urls: string[]) {
    batch.request = new AbortController()
    let name = ''
    try {
      for (const [index, file] of batch.files.entries()) {
        if (this.current !== batch) return
        name = file.name
        const response = await apiFetch(urls[index]!, { method: 'PUT', body: file,
          headers: { 'Content-Type': 'application/octet-stream' }, signal: batch.request.signal }, batch.context)
        if (!response.ok) throw new Error('Upload failed')
      }
      // The last PUT commits the batch and inserts its paths on the server.
      if (this.current === batch) this.finish('completed')
    } catch {
      if (this.current !== batch) return
      if (batch.cancelling) return
      // A lost request is a failure, not permission to delete earlier successes.
      // The server retires it on request abort or its existing upload deadline.
      this.finish('failed', t('terminal.upload.fileFailed', { name, error: t('terminal.upload.failed') }))
    }
  }

  private finish(state: 'completed' | 'cancelled' | 'failed', error?: string) {
    const batch = this.current
    if (!batch) return
    clearTimeout(this.timer)
    this.current = undefined
    if (state !== 'completed') { batch.request?.abort(); this.pending = [] }
    this.update({ state, error, cancelling: false, rejected: undefined, ...(state === 'completed' ? { transferred: batch.total } : {}) })
    if (this.pending.length) { this.next(); return }
    this.dismissed = setTimeout(() => { this.state = undefined; this.options.changed(undefined) }, state === 'failed' ? 6000 : 1800)
  }

  cancel() {
    this.pending = []
    if (this.current) {
      const batch = this.current
      if (batch.cancelling) return
      batch.cancelling = true
      this.options.send({ type: 'upload-cancel', id: batch.id })
      batch.request?.abort()
      clearTimeout(this.timer)
      this.update({ cancelling: true })
      this.timer = setTimeout(() => { if (this.current === batch) this.finish('cancelled') }, 5000)
    } else this.clear()
  }

  disconnected() {
    if (this.current) this.finish('failed', t('terminal.connection.interrupted'))
    this.pending = []
  }

  clear() {
    this.pending = []
    this.current?.request?.abort()
    this.current = undefined
    clearTimeout(this.timer)
    clearTimeout(this.dismissed)
    this.state = undefined
    this.options.changed(undefined)
  }
}

export function preventFileNavigation(event: DragEvent) {
  if (!hasFileTransfer(event.dataTransfer)) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'
}
/** Capture files before xterm pastes fallback text; plain text stays with xterm. */
export function bindFileInput(host: HTMLElement, uploads: TerminalUploads, dragging: (value: boolean) => void) {
  const accept = (data: DataTransfer | null) => {
    const { files, error } = readFileTransfer(data)
    if (error) uploads.reject(t(error === 'folders' ? 'terminal.upload.foldersUnsupported' : 'terminal.upload.unreadable'))
    else uploads.enqueue(files)
  }
  const paste = (event: ClipboardEvent) => {
    if (!hasFileTransfer(event.clipboardData)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    accept(event.clipboardData)
  }
  const over = (event: DragEvent) => {
    if (!hasFileTransfer(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    dragging(true)
  }
  const leave = (event: DragEvent) => {
    if (event.relatedTarget instanceof Node && host.contains(event.relatedTarget)) return
    dragging(false)
  }
  const drop = (event: DragEvent) => {
    if (!hasFileTransfer(event.dataTransfer)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    dragging(false)
    accept(event.dataTransfer)
  }
  host.addEventListener('paste', paste, true)
  host.addEventListener('dragenter', over)
  host.addEventListener('dragover', over)
  host.addEventListener('dragleave', leave)
  host.addEventListener('drop', drop, true)
  return () => {
    host.removeEventListener('paste', paste, true)
    host.removeEventListener('dragenter', over)
    host.removeEventListener('dragover', over)
    host.removeEventListener('dragleave', leave)
    host.removeEventListener('drop', drop, true)
    dragging(false)
  }
}
