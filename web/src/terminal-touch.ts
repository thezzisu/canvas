import type { Terminal } from '@xterm/xterm'

export type TerminalTouchMode = 'scroll' | 'mouse' | 'select'
interface TouchOptions {
  active(): boolean
  mode(): TerminalTouchMode
  focus(): void
  copyGesture(): void
  suppressInput(action: () => void): void
}

/** Touch scroll and native mouse gestures are deliberately separate modes. */
export function bindTerminalTouch(surface: HTMLElement, term: Terminal, options: TouchOptions) {
  let gesture: { id: number; x: number; y: number; startX: number; startY: number; lastY: number; remainder: number; mouse: boolean; moved: boolean } | undefined
  const mouse = (type: string, x: number, y: number, buttons: number) => term.element?.dispatchEvent(new MouseEvent(type, {
    bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons,
  }))
  let bindingsChanged = false
  // Native clients may briefly disable and restore mouse reporting during a
  // redraw. xterm removes its document drag/up listeners on disable, but only
  // binds them again on a new press. Keep the existing touch gesture continuous
  // without sending another press or disturbing the software keyboard.
  const observers = (['h', 'l'] as const).map(final => term.parser.registerCsiHandler({ prefix: '?', final }, params => {
    if (gesture?.mouse && params.some(param => [9, 1000, 1002, 1003].includes(param as number))) bindingsChanged = true
    return false
  }))
  observers.push(term.parser.registerEscHandler({ final: 'c' }, () => {
    if (gesture?.mouse) bindingsChanged = true
    return false
  }))
  const resumeMouse = () => {
    if (!gesture?.mouse || !bindingsChanged || !options.active() || term.modes.mouseTrackingMode === 'none') return
    bindingsChanged = false
    options.suppressInput(() => mouse('mousedown', gesture!.x, gesture!.y, 1))
  }
  const finish = () => {
    if (gesture?.mouse) { resumeMouse(); mouse('mouseup', gesture.x, gesture.y, 0) }
    gesture = undefined
    bindingsChanged = false
  }
  const start = (event: TouchEvent) => {
    if (!options.active() || options.mode() === 'select') return
    if (event.touches.length !== 1) { finish(); event.preventDefault(); return }
    const touch = event.touches[0]!
    event.preventDefault(); event.stopPropagation(); options.focus()
    gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, startX: touch.clientX, startY: touch.clientY, lastY: touch.clientY,
      remainder: 0, mouse: options.mode() === 'mouse', moved: false }
    bindingsChanged = false
    if (gesture.mouse) mouse('mousedown', touch.clientX, touch.clientY, 1)
  }
  const move = (event: TouchEvent) => {
    if (!gesture) return
    event.preventDefault(); event.stopPropagation()
    if (!options.active() || event.touches.length !== 1) { finish(); return }
    const touch = [...event.touches].find(touch => touch.identifier === gesture!.id)
    if (!touch) { finish(); return }
    if (Math.hypot(touch.clientX - gesture.startX, touch.clientY - gesture.startY) > 3) gesture.moved = true
    const delta = gesture.lastY - touch.clientY
    gesture.x = touch.clientX; gesture.y = touch.clientY; gesture.lastY = touch.clientY
    if (gesture.mouse) { resumeMouse(); mouse('mousemove', touch.clientX, touch.clientY, 1); return }
    const screen = term.element?.querySelector<HTMLElement>('.xterm-screen')
    const lineHeight = Math.max(8, (screen?.getBoundingClientRect().height || term.rows * 14) / term.rows)
    gesture.remainder += delta
    const lines = Math.trunc(gesture.remainder / lineHeight)
    if (!lines) return
    gesture.remainder -= lines * lineHeight
    if (term.modes.mouseTrackingMode !== 'none' || term.buffer.active.type === 'alternate') {
      term.element?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true,
        clientX: touch.clientX, clientY: touch.clientY, deltaY: lines * lineHeight, deltaMode: 0 }))
    } else term.scrollLines(lines)
  }
  const end = (event: TouchEvent) => {
    if (!gesture) return
    event.preventDefault(); event.stopPropagation()
    if (gesture.mouse && gesture.moved && event.isTrusted) options.copyGesture()
    finish()
  }
  const cancel = () => finish()
  surface.addEventListener('touchstart', start, { passive: false })
  surface.addEventListener('touchmove', move, { passive: false })
  surface.addEventListener('touchend', end, { passive: false })
  surface.addEventListener('touchcancel', cancel)
  window.addEventListener('blur', cancel)
  return () => {
    finish()
    observers.forEach(observer => observer.dispose())
    surface.removeEventListener('touchstart', start)
    surface.removeEventListener('touchmove', move)
    surface.removeEventListener('touchend', end)
    surface.removeEventListener('touchcancel', cancel)
    window.removeEventListener('blur', cancel)
  }
}
