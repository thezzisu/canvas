import type { CellPoint } from '../../utils/terminal/cell-selection'
import { encodeMouse, type EncodedMouse } from '../../utils/terminal/terminal-encoder'
import type { TerminalSelection } from './terminal-selection'

interface MouseOptions {
  /** This view may send input now. */
  active(): boolean
  /** The cell under a viewport point, clamped to the grid. */
  cell(x: number, y: number): CellPoint
  send(data: string): void
  /** Passive motion is reported too. */
  hover(): boolean
  selection: TerminalSelection
  /** A press that selects in this browser instead of reaching the program. */
  selects(event: MouseEvent): boolean
  /** A row's height on screen, in CSS pixels. */
  rowHeight(): number
}

type Modifiers = Pick<MouseEvent, 'shiftKey' | 'altKey' | 'ctrlKey'>

/**
 * The mouse of a terminal: left and middle presses, drags, motion and the wheel become reports
 * for the cell under the pointer. Motion inside one cell is reported once. The right button has
 * its own owner (`bindTerminalMouseDefaults`).
 */
export function bindTerminalMouse(surface: HTMLElement, options: MouseOptions) {
  let held: 'left' | 'middle' | 'select' | undefined
  let last: CellPoint | undefined
  let wheel = 0
  const capture = { capture: true }

  function report(
    type: EncodedMouse['type'],
    button: EncodedMouse['button'],
    cell: CellPoint,
    modifiers: Modifiers,
  ) {
    options.send(
      encodeMouse({
        type,
        button,
        ...cell,
        shift: modifiers.shiftKey,
        alt: modifiers.altKey,
        ctrl: modifiers.ctrlKey,
      }),
    )
  }
  /** A move, unless the pointer is still in the cell last reported. */
  function moved(button: EncodedMouse['button'], cell: CellPoint, modifiers: Modifiers) {
    if (last?.column === cell.column && last.row === cell.row) return
    last = cell
    report('move', button, cell, modifiers)
  }
  const at = (event: MouseEvent) => options.cell(event.clientX, event.clientY)

  const drag = (event: MouseEvent) => {
    if (held === 'select') options.selection.extend(at(event))
    else if (held && options.active()) moved(held, at(event), event)
  }
  const release = (event: MouseEvent) => {
    if (!held || event.button !== (held === 'middle' ? 1 : 0)) return
    if (held !== 'select' && options.active()) report('release', held, at(event), event)
    drop()
  }
  function drop() {
    held = undefined
    document.removeEventListener('mousemove', drag, capture)
    document.removeEventListener('mouseup', release, capture)
  }
  const press = (event: MouseEvent) => {
    // The hidden input keeps the keyboard: a press on the grid must not take focus from it.
    event.preventDefault()
    if (event.button > 1 || held || !options.active()) return
    const cell = at(event)
    if (event.button === 0 && options.selects(event)) {
      held = 'select'
      options.selection.begin(cell, event.detail)
    } else {
      held = event.button === 0 ? 'left' : 'middle'
      last = cell
      report('press', held, cell, event)
    }
    document.addEventListener('mousemove', drag, capture)
    document.addEventListener('mouseup', release, capture)
  }
  const hover = (event: MouseEvent) => {
    if (held || event.buttons || !options.hover() || options.selection.active) return
    if (options.active()) moved('none', at(event), event)
  }
  const left = () => {
    if (!held) last = undefined
  }
  const turned = (event: WheelEvent) => {
    // The canvas keeps a wheel that is not the terminal's from getting here.
    if (!options.active()) return
    event.preventDefault()
    event.stopPropagation()
    // As xterm.js counts it: whole rows per event, the rest carried to the next.
    const rows =
      event.deltaMode === WheelEvent.DOM_DELTA_PIXEL
        ? event.deltaY / Math.max(1, options.rowHeight())
        : event.deltaY
    wheel += rows
    const whole = Math.trunc(wheel)
    wheel -= whole
    if (whole) report('wheel', whole > 0 ? 'down' : 'up', at(event), event)
  }
  const cancel = () => {
    if (held && held !== 'select' && last && options.active())
      report('release', held, last, { shiftKey: false, altKey: false, ctrlKey: false })
    drop()
  }
  surface.addEventListener('mousedown', press)
  surface.addEventListener('mousemove', hover)
  surface.addEventListener('mouseleave', left)
  surface.addEventListener('wheel', turned, { passive: false })
  window.addEventListener('blur', cancel)
  return {
    dispose() {
      cancel()
      surface.removeEventListener('mousedown', press)
      surface.removeEventListener('mousemove', hover)
      surface.removeEventListener('mouseleave', left)
      surface.removeEventListener('wheel', turned)
      window.removeEventListener('blur', cancel)
    },
  }
}
