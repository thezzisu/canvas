import { effectScope } from 'vue'
import { useEventListener, useResizeObserver } from '@vueuse/core'
import type { TerminalModifiers } from '../../utils/terminal/terminal-input'
import {
  TouchpadGesture,
  type TouchpadButton,
  type TouchpadControl,
} from '../../utils/touchpad-gesture'

interface TouchpadOptions {
  active(): boolean
  enabled(): boolean
  hover(): boolean
  focus(): void
  modifiers(): TerminalModifiers
  copyGesture(): void
  grid(): { cols: number; rows: number }
  send(data: string): void
  /** Passive motion is kept from the program while this browser has a selection. */
  selecting(): boolean
  /** Where the pointer is, for the link under it; nothing when it is gone. */
  point(cell?: { column: number; row: number }): void
  /** A left click landed on a cell. */
  click(cell: { column: number; row: number }): void
}

/** One browser-local pointer; native pane ownership still goes through terminal input. */
export function bindTerminalTouchpad(
  surface: HTMLElement,
  screen: HTMLElement,
  options: TouchpadOptions,
) {
  const cursor = document.createElement('div')
  cursor.className = 'terminal-touchpad-cursor'
  cursor.hidden = true
  cursor.setAttribute('aria-hidden', 'true')
  cursor.innerHTML =
    '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M3 2l17 12-8 1-4 7z" fill="#fff" stroke="#111317" stroke-width="2" stroke-linejoin="round"/></svg>'
  screen.appendChild(cursor)
  Object.assign(cursor.style, {
    position: 'absolute',
    pointerEvents: 'none',
    zIndex: '8',
    transformOrigin: 'top left',
  })
  const position = { x: 0.5, y: 0.5 }
  let left = false,
    dragged = false,
    pointing = false,
    remainderX = 0,
    remainderY = 0
  const active = () => options.enabled() && options.active() && screen.isConnected
  function point() {
    const rect = screen.getBoundingClientRect()
    return {
      rect,
      clientX: rect.left + position.x * rect.width,
      clientY: rect.top + position.y * rect.height,
    }
  }
  function render() {
    cursor.hidden = !active()
    if (cursor.hidden) return
    const { rect } = point()
    const scale = rect.width / screen.offsetWidth || 1
    cursor.style.left = `${position.x * screen.offsetWidth}px`
    cursor.style.top = `${position.y * screen.offsetHeight}px`
    cursor.style.transform = `translate(-2px,-2px) scale(${1 / scale})`
  }
  const cell = () => {
    const { cols, rows } = options.grid()
    return {
      column: Math.min(cols - 1, Math.floor(position.x * cols)),
      row: Math.min(rows - 1, Math.floor(position.y * rows)),
    }
  }
  // Raw reports: the window's client also takes the horizontal wheel, which a mouse never sends.
  function send(code: number, up = false) {
    if (!active()) return
    const modifiers = options.modifiers()
    code += (modifiers.shift ? 4 : 0) + (modifiers.alt ? 8 : 0) + (modifiers.ctrl ? 16 : 0)
    const { column, row } = cell()
    options.send(`\x1b[<${code};${column + 1};${row + 1}${up ? 'm' : 'M'}`)
  }
  function showPointer(shown: boolean) {
    pointing = shown
    options.point(shown ? cell() : undefined)
  }
  function release() {
    if (left) send(0, true)
    left = false
    dragged = false
  }
  function pressLeft() {
    if (!active() || left) return false
    left = true
    send(0)
    return true
  }
  function finishDrag(cancelled: boolean) {
    const copied = dragged && !cancelled
    release()
    if (copied) options.copyGesture()
  }
  function click(button: TouchpadButton) {
    if (!active() || left) return
    options.focus()
    if (button === 'right') {
      const { clientX, clientY } = point()
      const modifiers = options.modifiers()
      // Let the existing right-button preference and pane menu own this gesture.
      screen.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          pointerType: 'touch',
          button: 2,
          buttons: 2,
          clientX,
          clientY,
        }),
      )
      for (const type of ['mousedown', 'mouseup', 'contextmenu'])
        screen.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            button: 2,
            buttons: type === 'mousedown' ? 2 : 0,
            clientX,
            clientY,
            shiftKey: modifiers.shift,
            ctrlKey: modifiers.ctrl,
            altKey: modifiers.alt,
            metaKey: modifiers.meta,
          }),
        )
    } else {
      const code = button === 'left' ? 0 : 1
      send(code)
      send(code, true)
      if (button === 'left') {
        showPointer(true)
        options.click(cell())
      }
    }
  }
  function move(x: number, y: number) {
    if (!active()) return
    const { rect } = point()
    if (!rect.width || !rect.height) return
    position.x = Math.max(0, Math.min(1 - 1 / rect.width, position.x + x / rect.width))
    position.y = Math.max(0, Math.min(1 - 1 / rect.height, position.y + y / rect.height))
    render()
    dragged ||= left
    if (!left) showPointer(true)
    if (left || (options.hover() && !options.selecting())) send(left ? 32 : 35)
  }
  function scroll(x: number, y: number) {
    if (!active() || left) return
    const { rect } = point(),
      step = Math.max(8, rect.height / options.grid().rows)
    remainderX += x
    remainderY += y
    for (const [delta, positive, negative] of [
      [remainderX, 67, 66],
      [remainderY, 65, 64],
    ]) {
      const count = Math.trunc(delta! / step)
      for (let i = 0; i < Math.min(15, Math.abs(count)); i++)
        send(count > 0 ? positive! : negative!)
    }
    remainderX %= step
    remainderY %= step
  }
  const gesture = new TouchpadGesture({
    move,
    scroll,
    tap: click,
    startDrag: pressLeft,
    endDrag: finishDrag,
  })
  const stopEvent = (event: TouchEvent) => {
    event.preventDefault()
    event.stopPropagation()
  }
  const fingers = (event: TouchEvent) =>
    [...event.touches].filter(
      (touch) => touch.target instanceof Node && surface.contains(touch.target),
    )
  const touch = (event: TouchEvent) => {
    if (!active()) {
      gesture.cancel()
      return
    }
    stopEvent(event)
    if (event.type === 'touchstart') options.focus()
    // A finger holding a virtual button is outside the terminal touch surface.
    gesture.update(fingers(event), performance.now())
  }
  const end = (event: TouchEvent) => {
    if (!active()) {
      gesture.cancel()
      return
    }
    stopEvent(event)
    gesture.end(fingers(event).length, performance.now())
  }
  function cancel() {
    gesture.cancel()
    release()
    remainderX = remainderY = 0
    if (pointing) showPointer(false)
  }
  // Terminal sessions outlive their card component when maximization moves hosts.
  const scope = effectScope(true)
  scope.run(() => {
    useEventListener(surface, ['touchstart', 'touchmove'], touch, { passive: false })
    useEventListener(surface, 'touchend', end, { passive: false })
    useEventListener(surface, 'touchcancel', cancel)
    useEventListener(window, 'blur', cancel)
    useEventListener(document, 'visibilitychange', () => {
      if (document.hidden) cancel()
    })
    useEventListener(surface, 'focusout', () =>
      queueMicrotask(() => {
        if (!surface.contains(document.activeElement)) cancel()
      }),
    )
    useResizeObserver(screen, render)
  })
  const controller = {
    refresh() {
      if (!active()) cancel()
      render()
    },
    cancel,
    control(action: TouchpadControl) {
      gesture.cancel()
      if (action.type === 'left' && !action.pressed) {
        finishDrag(!!action.cancelled)
        return
      }
      if (!active()) return
      if (!surface.contains(document.activeElement)) options.focus()
      if (action.type === 'left') pressLeft()
      else if (action.type === 'click') click(action.button)
      else scroll(action.x, action.y)
    },
    dispose() {
      cancel()
      scope.stop()
      cursor.remove()
    },
  }
  return controller
}
