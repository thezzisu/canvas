import type { RightClickMode } from './terminal-settings'

export type RightMouseAction = 'down' | 'drag' | 'up'
export function rightMouseInput(event: Pick<MouseEvent, 'clientX' | 'clientY' | 'shiftKey' | 'altKey' | 'ctrlKey'>,
  action: RightMouseAction, rect: { left: number; top: number; width: number; height: number }, cols: number, rows: number): string {
  if (!(rect.width > 0 && rect.height > 0)) return ''
  const column = Math.floor((event.clientX - rect.left) * cols / rect.width)
  const row = Math.floor((event.clientY - rect.top) * rows / rect.height)
  if (action === 'down' && (column < 0 || row < 0 || column >= cols || row >= rows)) return ''
  const code = 2 + (action === 'drag' ? 32 : 0) + (event.shiftKey ? 4 : 0) + (event.altKey ? 8 : 0) + (event.ctrlKey ? 16 : 0)
  return `\x1b[<${code};${Math.max(0, Math.min(cols - 1, column)) + 1};${Math.max(0, Math.min(rows - 1, row)) + 1}${action === 'up' ? 'm' : 'M'}`
}

/** One right-click gesture has one owner, even if a peer changes its preference. */
export function bindTerminalMouseDefaults(surface: HTMLElement, active: () => boolean,
  mode: () => RightClickMode, send: (event: MouseEvent, action: RightMouseAction) => boolean) {
  let middlePaste = false
  let right: { mode: RightClickMode; held: boolean; last?: MouseEvent } | undefined
  const prevent = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation() }
  const reset = () => {
    if (right?.held && right.mode === 'terminal' && right.last) send(right.last, 'up')
    detach()
    middlePaste = false; right = undefined
  }
  const nextPointer = (event: PointerEvent) => {
    middlePaste = false
    if (right?.held && !(event.buttons & 2)) reset()
    else if (!right?.held) right = undefined
  }
  const key = () => { middlePaste = false; if (!right?.held) right = undefined }
  const pointer = (event: PointerEvent) => {
    middlePaste = active() && event.button === 1
    if (active() && event.button === 2) right = { mode: mode(), held: false }
  }
  const press = (event: MouseEvent) => {
    if (event.button !== 2 || !active()) return
    right ||= { mode: mode(), held: false }
    right.last = event
    prevent(event)
    right.held = right.mode === 'menu' || send(event, 'down')
    if (right.held) { document.addEventListener('mousemove', move, options); document.addEventListener('mouseup', release, options) }
  }
  const move = (event: MouseEvent) => {
    if (!right?.held || !(event.buttons & 2)) return
    right.last = event
    prevent(event)
    if (active() && right.mode === 'terminal') send(event, 'drag')
  }
  const release = (event: MouseEvent) => {
    if (!right?.held || event.button !== 2) return
    prevent(event)
    if (active() && right.mode === 'terminal') send(event, 'up')
    // Windows dispatches contextmenu after mouseup; retain this gesture's mode.
    right.held = false
    detach()
  }
  const context = (event: Event) => { if (active()) prevent(event) }
  const paste = (event: Event) => {
    const native = middlePaste
    middlePaste = false
    // Chromium can emit primary-selection paste even after cancelled auxclick.
    if (native) context(event)
  }
  const auxiliary = (event: MouseEvent) => { if (event.button === 1) context(event) }
  const options = { capture: true }, document = surface.ownerDocument
  document.addEventListener('pointerdown', nextPointer, options)
  const detach = () => { document.removeEventListener('mousemove', move, options); document.removeEventListener('mouseup', release, options) }
  document.addEventListener('keydown', key, options)
  document.addEventListener('visibilitychange', reset)
  document.defaultView?.addEventListener('blur', reset)
  surface.addEventListener('pointerdown', pointer, options)
  surface.addEventListener('mousedown', press, options)
  surface.addEventListener('paste', paste, options)
  surface.addEventListener('contextmenu', context, options)
  surface.addEventListener('auxclick', auxiliary, options)
  return {
    allowsContextMenu: () => (right?.mode || mode()) === 'menu',
    dispose() {
      reset()
      document.removeEventListener('pointerdown', nextPointer, options)
      document.removeEventListener('mousemove', move, options)
      document.removeEventListener('mouseup', release, options)
      document.removeEventListener('keydown', key, options)
      document.removeEventListener('visibilitychange', reset)
      document.defaultView?.removeEventListener('blur', reset)
      surface.removeEventListener('pointerdown', pointer, options)
      surface.removeEventListener('mousedown', press, options)
      surface.removeEventListener('paste', paste, options)
      surface.removeEventListener('contextmenu', context, options)
      surface.removeEventListener('auxclick', auxiliary, options)
    },
  }
}
