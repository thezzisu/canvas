import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { CellPoint } from '../../utils/terminal/cell-selection.ts'
import { bindTerminalMouse } from './terminal-mouse.ts'
import type { TerminalSelection } from './terminal-selection.ts'

/** A surface of 10 by 20 px cells at the page's origin. */
function fixture(t: TestContext) {
  const surface = new EventTarget(),
    page = new EventTarget(),
    view = new EventTarget()
  const saved = ['document', 'window', 'WheelEvent'].map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  )
  const globals = { document: page, window: view, WheelEvent: { DOM_DELTA_PIXEL: 0 } }
  for (const [name, value] of Object.entries(globals))
    Object.defineProperty(globalThis, name, { configurable: true, value })
  const sent: string[] = [],
    selected: string[] = []
  const state = { active: true, hover: true, selecting: false }
  const selection = {
    get active() {
      return state.selecting
    },
    begin: (point: CellPoint, clicks: number) =>
      selected.push(`begin ${point.column},${point.row} x${clicks}`),
    extend: (point: CellPoint) => selected.push(`extend ${point.column},${point.row}`),
  } as unknown as TerminalSelection
  const mouse = bindTerminalMouse(surface as HTMLElement, {
    active: () => state.active,
    cell: (x, y) => ({ column: Math.floor(x / 10), row: Math.floor(y / 20) }),
    send: (data) => sent.push(data),
    hover: () => state.hover,
    selection,
    selects: (event) => event.shiftKey,
    rowHeight: () => 20,
  })
  t.after(() => {
    mouse.dispose()
    for (const [name, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
  })
  const fire = (target: EventTarget, type: string, x: number, y: number, extra = {}) => {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 0,
      detail: 1,
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      ...extra,
    })
    target.dispatchEvent(event)
    return event
  }
  return { surface, page, view, sent, selected, state, fire }
}

test('a press, a drag once per cell and a release anywhere on the page are reported', (t) => {
  const { surface, page, sent, fire } = fixture(t)
  assert.equal(fire(surface, 'mousedown', 15, 25).defaultPrevented, true)
  fire(page, 'mousemove', 17, 27, { buttons: 1 })
  fire(page, 'mousemove', 31, 27, { buttons: 1, ctrlKey: true })
  fire(page, 'mousemove', 33, 29, { buttons: 1, ctrlKey: true })
  fire(page, 'mouseup', 500, 400)
  fire(page, 'mousemove', 55, 55, { buttons: 1 })
  assert.deepEqual(sent, ['\x1b[<0;2;2M', '\x1b[<48;4;2M', '\x1b[<0;51;21m'])
  sent.length = 0
  fire(surface, 'mousedown', 5, 5, { button: 1, altKey: true })
  // Another button's release does not end the gesture.
  fire(page, 'mouseup', 5, 5, { button: 0 })
  fire(page, 'mouseup', 5, 5, { button: 1 })
  fire(surface, 'mousedown', 5, 5, { button: 2 })
  assert.deepEqual(sent, ['\x1b[<9;1;1M', '\x1b[<1;1;1m'])
})

test('plain motion is reported once per cell, and only with hover on and nothing selected', (t) => {
  const { surface, sent, state, fire } = fixture(t)
  for (const x of [11, 12, 19, 21, 22]) fire(surface, 'mousemove', x, 5)
  assert.deepEqual(sent, ['\x1b[<35;2;1M', '\x1b[<35;3;1M'])
  // Leaving forgets the cell: coming back to it is new motion.
  fire(surface, 'mouseleave', 0, 0)
  fire(surface, 'mousemove', 22, 5)
  assert.equal(sent.length, 3)
  state.hover = false
  fire(surface, 'mousemove', 55, 5)
  state.hover = true
  state.selecting = true
  fire(surface, 'mousemove', 65, 5)
  state.selecting = false
  state.active = false
  fire(surface, 'mousemove', 75, 5)
  assert.equal(sent.length, 3)
})

test('a selecting press and its drag stay in the browser', (t) => {
  const { surface, page, sent, selected, fire } = fixture(t)
  fire(surface, 'mousedown', 15, 25, { shiftKey: true, detail: 2 })
  fire(page, 'mousemove', 45, 45, { buttons: 1, shiftKey: true })
  fire(page, 'mouseup', 45, 45, { shiftKey: true })
  fire(page, 'mousemove', 85, 85, { buttons: 1 })
  assert.deepEqual(selected, ['begin 1,1 x2', 'extend 4,2'])
  assert.deepEqual(sent, [])
})

test('the wheel sends whole rows and carries the rest', (t) => {
  const { surface, sent, state, fire } = fixture(t)
  const wheel = (deltaY: number, deltaMode = 0) =>
    fire(surface, 'wheel', 25, 45, { deltaY, deltaMode })
  assert.equal(wheel(12).defaultPrevented, true)
  assert.deepEqual(sent, [])
  wheel(12)
  wheel(-30)
  wheel(3, 1)
  assert.deepEqual(sent, ['\x1b[<65;3;3M', '\x1b[<64;3;3M', '\x1b[<65;3;3M'])
  state.active = false
  assert.equal(wheel(100).defaultPrevented, false)
  assert.equal(sent.length, 3)
})

test('losing the window releases a held button where it was last reported', (t) => {
  const { surface, page, view, sent, fire } = fixture(t)
  fire(surface, 'mousedown', 15, 25)
  fire(page, 'mousemove', 45, 45, { buttons: 1 })
  view.dispatchEvent(new Event('blur'))
  fire(page, 'mouseup', 45, 45)
  assert.deepEqual(sent, ['\x1b[<0;2;2M', '\x1b[<32;5;3M', '\x1b[<0;5;3m'])
})
