import type { Terminal } from '@xterm/xterm'
import { isPasteShortcut } from './clipboard-shortcuts'

const MAX_COPY_BYTES = 1024 * 1024
const COPY_GESTURE_MS = 3000
let restoringFocus = false
export const clipboardRestoringFocus = () => restoringFocus

/** A user copy works on HTTP as well as secure origins. Never read the clipboard. */
export function copyText(text: string, failed: () => void): boolean {
  if (!text) return false
  if (new TextEncoder().encode(text).length > MAX_COPY_BYTES) { failed(); return false }
  const documentSelection = document.getSelection()
  const ranges = documentSelection ? Array.from({ length: documentSelection.rangeCount }, (_, index) => documentSelection.getRangeAt(index).cloneRange()) : []
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  const input = previous instanceof HTMLInputElement || previous instanceof HTMLTextAreaElement ? previous : undefined
  const inputSelection = input ? { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection } : undefined
  const area = document.createElement('textarea')
  area.value = text
  area.readOnly = true
  area.tabIndex = -1
  area.setAttribute('aria-hidden', 'true')
  Object.assign(area.style, { position: 'fixed', left: '0', top: '0', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' })
  const onCopy = (event: ClipboardEvent) => {
    if (!event.clipboardData) return
    event.clipboardData.setData('text/plain', text)
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  let copied = false
  try {
    const root = document.fullscreenElement || document.body
    root.append(area)
    document.addEventListener('copy', onCopy, true)
    area.focus({ preventScroll: true })
    area.select()
    copied = document.execCommand('copy')
  } catch { /* A secure clipboard API can still succeed when legacy copy is blocked. */ }
  finally {
    document.removeEventListener('copy', onCopy, true)
    area.remove()
    restoringFocus = true
    try {
      if (previous?.isConnected) previous.focus({ preventScroll: true })
      if (input?.isConnected && inputSelection && inputSelection.start !== null && inputSelection.end !== null) {
        input.setSelectionRange(inputSelection.start, inputSelection.end, inputSelection.direction || undefined)
      } else if (documentSelection) {
        documentSelection.removeAllRanges()
        for (const range of ranges) documentSelection.addRange(range)
      }
    } catch { /* Selection may have been removed while the copy event ran. */ }
    finally { restoringFocus = false }
  }
  if (!copied && navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).catch(failed)
    return true
  }
  if (!copied) failed()
  return copied
}

export type ClipboardNotice = 'failed' | 'macPaste'

interface ClipboardOptions {
  visible(): boolean
  controlsInput(): boolean
  copyError(value: ClipboardNotice | undefined): void
}

/** Copy is authorized only by a real gesture in this terminal, never by replay. */
export class TerminalClipboard {
  private gesture?: { x: number; y: number; moved: boolean; multiple: boolean; local: boolean }
  private lastCopiedSelection = ''
  private copyUntil = 0
  private readonly osc
  private noticeTimer?: ReturnType<typeof setTimeout>
  private disposed = false

  constructor(private readonly term: Terminal, private readonly surface: HTMLElement, private readonly options: ClipboardOptions) {
    surface.addEventListener('mousedown', this.mouseDown, true)
    document.addEventListener('mousemove', this.mouseMove, true)
    document.addEventListener('mouseup', this.mouseUp)
    surface.addEventListener('keyup', this.keyUp, true)
    surface.addEventListener('focusout', this.focusOut)
    window.addEventListener('blur', this.reset)
    this.osc = term.parser.registerOscHandler(52, data => this.osc52(data))
  }

  private ready() { return this.options.visible() && document.hasFocus() && document.visibilityState === 'visible' }
  private focused() { return !!this.term.element?.contains(document.activeElement) }
  private allowProgramCopy() {
    this.copyUntil = this.ready() && this.focused() && this.options.controlsInput() ? performance.now() + COPY_GESTURE_MS : 0
  }
  private copySelection() {
    if (!this.ready()) return false
    const text = this.term.getSelection()
    if (!text) return false
    this.copyUntil = 0
    this.lastCopiedSelection = text
    return this.copy(text)
  }
  private copy(text: string) {
    clearTimeout(this.noticeTimer)
    this.options.copyError(undefined)
    return copyText(text, () => this.notice('failed'))
  }
  copyText(text: string): boolean { return this.ready() && this.copy(text) }
  touchSelectionCompleted(): void { this.allowProgramCopy() }
  private notice(message: ClipboardNotice) {
    if (this.disposed) return
    clearTimeout(this.noticeTimer)
    this.options.copyError(message)
    this.noticeTimer = setTimeout(() => this.options.copyError(undefined), 5000)
  }

  key(event: KeyboardEvent): boolean {
    // Returning false skips xterm's Ctrl+V -> SYN mapping without cancelling
    // the browser's native paste event. Windows clipboard history can supply
    // the logical key without a physical code; images still arrive via paste.
    if (isPasteShortcut(event)) {
      if (event.type === 'keydown' && event.isTrusted && !event.repeat && /Mac/.test(navigator.platform) && event.ctrlKey && !event.metaKey) this.notice('macPaste')
      return false
    }
    const copy = !event.altKey && (event.code === 'KeyC' && (event.metaKey || event.ctrlKey && event.shiftKey)
      || event.key === 'Insert' && event.ctrlKey && !event.shiftKey && !event.metaKey)
    if (copy && event.type === 'keydown' && event.isTrusted) {
      this.allowProgramCopy()
      if (this.ready() && this.term.hasSelection()) { this.copySelection(); event.preventDefault(); return false }
    }
    if (copy && event.metaKey && !event.ctrlKey) return false
    return true
  }

  private mouseDown = (event: MouseEvent) => {
    if (!event.isTrusted || event.button !== 0 || !this.ready()) return
    this.copyUntil = 0
    const forced = /Mac/.test(navigator.platform) ? event.altKey && this.term.options.macOptionClickForcesSelection === true : event.shiftKey
    this.gesture = { x: event.screenX, y: event.screenY, moved: false, multiple: event.detail >= 2,
      local: this.term.modes.mouseTrackingMode === 'none' || forced }
  }
  private mouseMove = (event: MouseEvent) => {
    if (!event.isTrusted || !this.gesture) return
    if (Math.hypot(event.screenX - this.gesture.x, event.screenY - this.gesture.y) >= 3) this.gesture.moved = true
  }
  private mouseUp = (event: MouseEvent) => {
    const gesture = this.gesture
    this.gesture = undefined
    if (!event.isTrusted || event.button !== 0 || !gesture || !(gesture.moved || gesture.multiple)) return
    if (gesture.local) this.copySelection()
    else this.allowProgramCopy()
  }
  private keyUp = (event: KeyboardEvent) => {
    if (event.isTrusted && event.key === 'Shift' && this.focused() && this.gesture?.local && this.gesture.moved && this.term.getSelection() !== this.lastCopiedSelection) this.copySelection()
  }
  private reset = () => { this.gesture = undefined; this.copyUntil = 0 }
  private focusOut = (event: FocusEvent) => {
    if (!(event.relatedTarget instanceof Node) || !this.surface.contains(event.relatedTarget)) this.reset()
  }

  private osc52(data: string): boolean {
    const split = data.indexOf(';')
    if (split < 0) return true
    const selection = data.slice(0, split), payload = data.slice(split + 1)
    // Clipboard queries never read local data or produce a terminal response.
    if (payload === '?' || (selection !== '' && selection !== 'c')) return true
    if (!this.ready() || !this.focused() || !this.options.controlsInput() || performance.now() > this.copyUntil) return true
    this.copyUntil = 0
    if (!payload || payload.length > Math.ceil(MAX_COPY_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(payload)) return true
    try {
      const raw = atob(payload)
      if (raw.length > MAX_COPY_BYTES) return true
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(raw, character => character.charCodeAt(0)))
      this.copy(text)
    } catch { /* Invalid or oversized clipboard writes are ignored. */ }
    return true
  }

  dispose() {
    this.disposed = true
    this.reset()
    clearTimeout(this.noticeTimer)
    this.osc.dispose()
    this.surface.removeEventListener('mousedown', this.mouseDown, true)
    document.removeEventListener('mousemove', this.mouseMove, true)
    document.removeEventListener('mouseup', this.mouseUp)
    this.surface.removeEventListener('keyup', this.keyUp, true)
    this.surface.removeEventListener('focusout', this.focusOut)
    window.removeEventListener('blur', this.reset)
  }
}
