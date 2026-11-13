import { t } from '../../plugins/i18n'
import { transferError } from '../../api/transfer-error'
import { MAX_PASTE_PARTS, MAX_UPLOAD_BEGIN_BYTES, type PastePart } from '../../../../shared/paste'
import { apiContext, apiFetch, apiUrl, isCurrentApi, uuid, type ApiContext } from '../../api/api'
import { hasFileTransfer, readFileTransfer } from '../browser-file-input'

export interface TerminalUploadState {
  id?: string
  name: string
  fileCount?: number
  transferred: number
  total: number
  state: 'waiting' | 'preparing' | 'uploading' | 'completed' | 'cancelled' | 'failed'
  /** Composer sends report as "sent"; text-only ones show no progress at all. */
  kind?: 'upload' | 'send'
  hidden?: boolean
  error?: string
  queued?: number
  cancelling?: boolean
  rejected?: string
}
interface Batch {
  context: ApiContext
  id: string
  files: File[]
  parts?: PastePart[]
  total: number
  request?: AbortController
  running: boolean
  cancelling?: boolean
  /** Files already held by Canvas: the server streams them and reports progress. */
  stored?: {
    message: Record<string, unknown>
    name: string
    fileCount: number
    started?(): void
    done(error?: string): void
  }
}
interface UploadOptions {
  readiness(): 'ready' | 'waiting' | 'unavailable'
  unavailableReason(): string
  focus(): void
  send(message: object): boolean
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
    if (this.current) {
      this.update({ rejected: error })
      return
    }
    clearTimeout(this.dismissed)
    this.state = { name: '', transferred: 0, total: 0, state: 'failed', error }
    this.options.changed(this.state)
    this.dismissed = setTimeout(() => {
      this.state = undefined
      this.options.changed(undefined)
    }, 6000)
  }

  enqueue(files: File[], parts?: PastePart[], context = apiContext()) {
    if (!files.length) return
    if (!isCurrentApi(context)) {
      this.reject(t('terminal.upload.targetChanged'))
      return
    }
    if (this.options.readiness() === 'unavailable') {
      this.reject(this.options.unavailableReason())
      return
    }
    if (files.some((file) => file.webkitRelativePath)) {
      this.reject(t('terminal.upload.foldersUnsupported'))
      return
    }
    if (this.current?.cancelling) return
    const total = files.reduce((sum, file) => sum + file.size, 0)
    if (!Number.isSafeInteger(total)) {
      this.reject(t('terminal.upload.invalidSize'))
      return
    }
    const batch: Batch = { context, id: uuid(), files, parts, total, running: false }
    if (
      files.length > 64 ||
      (parts?.length || 0) > MAX_PASTE_PARTS ||
      new TextEncoder().encode(JSON.stringify(this.beginMessage(batch))).length >
        MAX_UPLOAD_BEGIN_BYTES
    ) {
      this.reject(t('terminal.richPaste.tooLarge'))
      return
    }
    this.pending.push(batch)
    if (this.current) this.update({ rejected: undefined })
    else this.next()
  }

  /** Queue a server-held delivery behind browser uploads; `done` reports its outcome to the sender. */
  enqueueStored(
    message: Record<string, unknown>,
    stored: { name: string; fileCount: number; started?(): void; done(error?: string): void },
    context = apiContext(),
  ) {
    const refuse = (error: string) => stored.done(error)
    if (!isCurrentApi(context)) {
      refuse(t('terminal.upload.targetChanged'))
      return
    }
    if (this.options.readiness() === 'unavailable') {
      refuse(this.options.unavailableReason())
      return
    }
    if (this.current?.cancelling) {
      refuse(t('terminal.upload.cancelling'))
      return
    }
    this.pending.push({
      context,
      id: uuid(),
      files: [],
      total: 0,
      running: false,
      stored: { message, ...stored },
    })
    if (this.current) this.update({ rejected: undefined })
    else this.next()
  }

  private beginMessage(batch: Batch) {
    if (batch.stored) return { ...batch.stored.message, id: batch.id }
    return {
      type: 'upload-begin',
      id: batch.id,
      files: batch.files.map((file) => ({ name: file.name, size: file.size })),
      ...(batch.parts ? { parts: batch.parts } : {}),
    }
  }

  private next() {
    if (this.current || !this.pending.length) return
    clearTimeout(this.dismissed)
    const readiness = this.options.readiness()
    const batch = this.pending[0]!
    if (!isCurrentApi(batch.context)) {
      this.invalidate(t('terminal.upload.targetChanged'))
      return
    }
    if (readiness === 'waiting') {
      if (
        this.state?.state === 'waiting' &&
        this.state.id === batch.id &&
        this.state.queued === this.pending.length - 1
      )
        return
      this.state = {
        ...batchView(batch),
        transferred: 0,
        total: batch.total,
        state: 'waiting',
        queued: this.pending.length - 1,
      }
      this.options.changed(this.state)
      return
    }
    if (readiness === 'unavailable') {
      this.invalidate(this.options.unavailableReason())
      return
    }
    this.pending.shift()
    this.current = batch
    batch.stored?.started?.()
    this.state = {
      ...batchView(batch),
      transferred: 0,
      total: batch.total,
      state: 'preparing',
      queued: this.pending.length,
    }
    this.options.changed(this.state)
    this.options.focus()
    if (!this.options.send(this.beginMessage(batch))) {
      this.finish('failed', t('terminal.connection.interrupted'))
      return
    }
    this.timer = setTimeout(() => {
      this.options.send({ type: 'upload-cancel', id: batch.id })
      this.finish('failed', t('terminal.upload.prepareTimeout'))
    }, 30_000)
  }

  /** Retry only an unsent picker batch after the owning terminal is ready. */
  refresh() {
    this.next()
  }

  get hasPending() {
    return this.pending.length > 0
  }

  /** Every dropped batch reports to its sender; stored sends must learn they did not happen. */
  private dropPending(error: string) {
    const dropped = this.pending
    this.pending = []
    for (const batch of dropped) batch.stored?.done(error)
  }

  /** Drop only unsent picker batches when their target is no longer valid. */
  invalidate(error = t('terminal.upload.disconnected')) {
    if (!this.pending.length) return
    this.dropPending(error)
    this.reject(error)
  }

  receive(message: Record<string, unknown>): boolean {
    if (message.type !== 'upload-ready' && message.type !== 'upload-progress') return false
    const batch = this.current
    if (!batch || message.id !== batch.id) return true
    if (message.type === 'upload-ready') {
      if (batch.cancelling) {
        this.options.send({ type: 'upload-cancel', id: batch.id })
        return true
      }
      if (batch.running) return true
      if (
        !Array.isArray(message.urls) ||
        message.urls.length !== batch.files.length ||
        !message.urls.every((value) => typeof value === 'string')
      ) {
        this.options.send({ type: 'upload-cancel', id: batch.id })
        this.finish('failed', t('terminal.upload.invalidUrl'))
        return true
      }
      const urls: string[] = []
      try {
        for (const value of message.urls as string[]) {
          const url = apiUrl(value, batch.context)
          if (
            !url.pathname.startsWith(`${new URL(batch.context.base).pathname}api/uploads/`) ||
            url.search
          )
            throw new Error('Invalid upload URL')
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
    if (batch.stored) {
      // The first report replaces the prepare timeout; a cancellation keeps its own fallback.
      if (!batch.cancelling) clearTimeout(this.timer)
      if (
        typeof message.total === 'number' &&
        Number.isSafeInteger(message.total) &&
        message.total >= 0 &&
        message.total !== batch.total
      ) {
        batch.total = message.total
        this.update({ total: batch.total })
      }
    }
    if (typeof message.transferred === 'number' && Number.isSafeInteger(message.transferred)) {
      this.update({
        transferred: Math.max(
          this.state?.transferred || 0,
          Math.min(batch.total, message.transferred),
        ),
      })
    }
    if (message.state === 'completed') this.finish('completed')
    else if (message.state === 'cancelled') this.finish('cancelled')
    else if (message.state === 'failed') {
      const error = transferError(message.error)
      this.finish(
        'failed',
        typeof message.failedFile === 'string'
          ? t('terminal.upload.fileFailed', { name: message.failedFile, error })
          : error,
      )
    } else if (message.state === 'uploading') this.update({ state: 'uploading' })
    return true
  }

  private async put(batch: Batch, urls: string[]) {
    batch.request = new AbortController()
    let name = ''
    try {
      for (const [index, file] of batch.files.entries()) {
        if (this.current !== batch) return
        name = file.name
        const response = await apiFetch(
          urls[index]!,
          {
            method: 'PUT',
            body: file,
            headers: { 'Content-Type': 'application/octet-stream' },
            signal: batch.request.signal,
          },
          batch.context,
        )
        if (!response.ok) throw new Error('Upload failed')
      }
      // The last PUT commits the batch and inserts its paths on the server.
      if (this.current === batch) this.finish('completed')
    } catch {
      if (this.current !== batch) return
      if (batch.cancelling) return
      // Release a batch even when a proxy failed before the PUT reached Canvas.
      // This reports failure, preserving earlier files rather than cancelling them.
      this.options.send({ type: 'upload-failed', id: batch.id })
      this.finish(
        'failed',
        t('terminal.upload.fileFailed', { name, error: t('terminal.upload.failed') }),
      )
    }
  }

  private finish(state: 'completed' | 'cancelled' | 'failed', error?: string) {
    const batch = this.current
    if (!batch) return
    clearTimeout(this.timer)
    this.current = undefined
    if (state !== 'completed') {
      batch.request?.abort()
      this.dropPending(error || t('terminal.upload.cancelled'))
    }
    if (batch.stored)
      batch.stored.done(state === 'completed' ? undefined : error || t('terminal.upload.cancelled'))
    this.update({
      state,
      error,
      cancelling: false,
      rejected: undefined,
      ...(state === 'completed' ? { transferred: batch.total } : {}),
    })
    if (this.current) return
    if (this.pending.length) {
      this.next()
      return
    }
    this.dismissed = setTimeout(
      () => {
        this.state = undefined
        this.options.changed(undefined)
      },
      state === 'failed' ? 6000 : 1800,
    )
  }

  cancel() {
    if (this.current) {
      this.dropPending(t('terminal.upload.cancelled'))
      const batch = this.current
      if (batch.cancelling) return
      batch.cancelling = true
      this.options.send({ type: 'upload-cancel', id: batch.id })
      batch.request?.abort()
      clearTimeout(this.timer)
      this.update({ cancelling: true })
      this.timer = setTimeout(() => {
        if (this.current === batch) this.finish('cancelled')
      }, 5000)
    } else if (this.pending.length) {
      this.dropPending(t('terminal.upload.cancelled'))
      clearTimeout(this.dismissed)
      this.state = { name: '', transferred: 0, total: 0, state: 'cancelled' }
      this.options.changed(this.state)
      this.dismissed = setTimeout(() => {
        this.state = undefined
        this.options.changed(undefined)
      }, 1800)
    } else this.clear()
  }

  disconnected() {
    if (this.current) this.finish('failed', t('terminal.connection.interrupted'))
  }

  clear() {
    this.dropPending(t('terminal.upload.targetChanged'))
    this.current?.stored?.done(t('terminal.upload.targetChanged'))
    this.current?.request?.abort()
    this.current = undefined
    clearTimeout(this.timer)
    clearTimeout(this.dismissed)
    this.state = undefined
    this.options.changed(undefined)
  }
}

/** How a batch presents itself; a text-only send has no progress to show. */
function batchView(
  batch: Batch,
): Pick<TerminalUploadState, 'id' | 'name' | 'fileCount' | 'kind' | 'hidden'> {
  if (batch.stored)
    return {
      id: batch.id,
      name: batch.stored.name,
      fileCount: batch.stored.fileCount,
      kind: 'send',
      hidden: !batch.stored.fileCount,
    }
  return {
    id: batch.id,
    name: batch.files.length === 1 ? batch.files[0]!.name : '',
    fileCount: batch.files.length,
    kind: 'upload',
  }
}

export function preventFileNavigation(event: DragEvent) {
  if (!hasFileTransfer(event.dataTransfer)) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'
}
/** Capture files before the terminal's input pastes fallback text; plain text stays with it. */
export function bindFileInput(
  host: HTMLElement,
  uploads: TerminalUploads,
  dragging: (value: boolean) => void,
  mixedPaste: (data: DataTransfer) => boolean,
) {
  const accept = (data: DataTransfer | null) => {
    const { files, error } = readFileTransfer(data)
    if (error)
      uploads.reject(
        t(
          error === 'folders' ? 'terminal.upload.foldersUnsupported' : 'terminal.upload.unreadable',
        ),
      )
    else uploads.enqueue(files)
  }
  const receivePaste = (event: Event, data: DataTransfer | null) => {
    const mixed = !!data && mixedPaste(data)
    if (!mixed && !hasFileTransfer(data)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (!mixed) accept(data)
  }
  const paste = (event: ClipboardEvent) => receivePaste(event, event.clipboardData)
  // Android IMEs may deliver clipboard content only through beforeinput.
  const beforeInput = (event: InputEvent) => {
    if (event.inputType === 'insertFromPaste' && event.dataTransfer)
      receivePaste(event, event.dataTransfer)
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
  host.addEventListener('beforeinput', beforeInput, true)
  host.addEventListener('dragenter', over)
  host.addEventListener('dragover', over)
  host.addEventListener('dragleave', leave)
  host.addEventListener('drop', drop, true)
  return () => {
    host.removeEventListener('paste', paste, true)
    host.removeEventListener('beforeinput', beforeInput, true)
    host.removeEventListener('dragenter', over)
    host.removeEventListener('dragover', over)
    host.removeEventListener('dragleave', leave)
    host.removeEventListener('drop', drop, true)
    dragging(false)
  }
}
