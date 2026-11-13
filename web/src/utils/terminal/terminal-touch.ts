import type { CellPoint } from './cell-selection'
import { encodeMouse } from './terminal-encoder'

export type TerminalTouchMode = 'scroll' | 'mouse' | 'select' | 'touchpad'
interface TouchOptions {
  active(): boolean
  mode(): TerminalTouchMode
  focus(): void
  copyGesture(): void
  /** The cell under a viewport point, clamped to the grid. */
  cell(x: number, y: number): CellPoint
  send(data: string): void
  /** A row's height on screen, in CSS pixels. */
  rowHeight(): number
}

/** Touch scroll and native mouse gestures are deliberately separate modes. */
export function bindTerminalTouch(surface: HTMLElement, options: TouchOptions) {
  let gesture:
    | {
        id: number
        cell: CellPoint
        startX: number
        startY: number
        lastY: number
        remainder: number
        mouse: boolean
        moved: boolean
      }
    | undefined
  const finish = () => {
    if (gesture?.mouse && options.active())
      options.send(encodeMouse({ type: 'release', button: 'left', ...gesture.cell }))
    gesture = undefined
  }
  const start = (event: TouchEvent) => {
    if (!options.active() || options.mode() === 'select' || options.mode() === 'touchpad') return
    if (event.touches.length !== 1) {
      finish()
      event.preventDefault()
      return
    }
    const touch = event.touches[0]!
    event.preventDefault()
    event.stopPropagation()
    options.focus()
    gesture = {
      id: touch.identifier,
      cell: options.cell(touch.clientX, touch.clientY),
      startX: touch.clientX,
      startY: touch.clientY,
      lastY: touch.clientY,
      remainder: 0,
      mouse: options.mode() === 'mouse',
      moved: false,
    }
    if (gesture.mouse) options.send(encodeMouse({ type: 'press', button: 'left', ...gesture.cell }))
  }
  const move = (event: TouchEvent) => {
    if (!gesture) return
    event.preventDefault()
    event.stopPropagation()
    if (!options.active() || event.touches.length !== 1) {
      finish()
      return
    }
    const touch = [...event.touches].find((touch) => touch.identifier === gesture!.id)
    if (!touch) {
      finish()
      return
    }
    if (Math.hypot(touch.clientX - gesture.startX, touch.clientY - gesture.startY) > 3)
      gesture.moved = true
    const delta = gesture.lastY - touch.clientY
    const cell = options.cell(touch.clientX, touch.clientY)
    const sameCell = cell.column === gesture.cell.column && cell.row === gesture.cell.row
    gesture.cell = cell
    gesture.lastY = touch.clientY
    if (gesture.mouse) {
      if (!sameCell) options.send(encodeMouse({ type: 'move', button: 'left', ...cell }))
      return
    }
    // The window's own client scrolls: a finger's travel becomes one wheel step per row.
    const rowHeight = Math.max(8, options.rowHeight())
    gesture.remainder += delta
    const rows = Math.trunc(gesture.remainder / rowHeight)
    if (!rows) return
    gesture.remainder -= rows * rowHeight
    const step = encodeMouse({ type: 'wheel', button: rows > 0 ? 'down' : 'up', ...cell })
    for (let count = Math.min(15, Math.abs(rows)); count; count--) options.send(step)
  }
  const end = (event: TouchEvent) => {
    if (!gesture) return
    event.preventDefault()
    event.stopPropagation()
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
    surface.removeEventListener('touchstart', start)
    surface.removeEventListener('touchmove', move)
    surface.removeEventListener('touchend', end)
    surface.removeEventListener('touchcancel', cancel)
    window.removeEventListener('blur', cancel)
  }
}
