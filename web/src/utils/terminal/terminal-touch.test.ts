import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { bindTerminalTouch, type TerminalTouchMode } from './terminal-touch.ts'

/** A grid of 17 px rows and 10 px columns from the page's origin. */
function fixture(t: TestContext, rowHeight = 17, mode: TerminalTouchMode = 'scroll') {
  const view = new EventTarget(),
    surface = new EventTarget(),
    sent: string[] = []
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: view })
  let focused = 0,
    copies = 0
  const dispose = bindTerminalTouch(surface as HTMLElement, {
    active: () => true,
    mode: () => mode,
    focus: () => {
      focused++
    },
    copyGesture: () => {
      copies++
    },
    cell: (x, y) => ({ column: Math.floor(x / 10), row: Math.floor(y / rowHeight) }),
    send: (data) => sent.push(data),
    rowHeight: () => rowHeight,
  })
  t.after(() => {
    dispose()
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  let y = 600
  function touch(type: string, x = 120) {
    const event = new Event(type, { cancelable: true })
    Object.assign(event, {
      touches:
        type === 'touchend' || type === 'touchcancel'
          ? []
          : [{ identifier: 1, clientX: x, clientY: y }],
    })
    surface.dispatchEvent(event)
    return event.defaultPrevented
  }
  function drag(deltas: number[]) {
    assert(touch('touchstart'))
    for (const delta of deltas) {
      y -= delta
      assert(touch('touchmove'))
    }
    assert(touch('touchend'))
  }
  /** Wheel steps sent, as 1 for down and -1 for up. */
  const wheels = () =>
    sent.map((data) => /^\x1b\[<(64|65);13;\d+M$/u.exec(data)?.[1]).map((code) => +code! * 2 - 129)
  return {
    sent,
    wheels,
    drag,
    touch,
    focused: () => focused,
    copies: () => copies,
    clear: () => {
      sent.length = 0
    },
    move: (delta: number, x?: number) => {
      y -= delta
      touch('touchmove', x)
    },
  }
}

test('scrolling reports one wheel step per crossed row, however the travel is chunked', (t) => {
  const f = fixture(t)
  for (const deltas of [[120], Array(6).fill(20), Array(12).fill(10)]) {
    f.clear()
    f.drag(deltas)
    assert.deepEqual(f.wheels(), Array(7).fill(1), '120 CSS pixels cross seven 17px rows')
  }
  assert.equal(f.focused(), 3, 'one focus per gesture, not per wheel report')
})

test('fractional row heights keep their remainder and reverse without inventing steps', (t) => {
  const f = fixture(t, 17.25)
  f.drag([6, -6, 12, 5.25, -17.25])
  assert.deepEqual(f.wheels(), [1, -1])
  f.clear()
  f.drag([23, 23, 23])
  assert.equal(f.sent.length, 4)
  f.clear()
  f.drag([69])
  assert.equal(f.sent.length, 4)
})

test('one move sends at most fifteen steps, and a cancelled gesture carries nothing over', (t) => {
  const f = fixture(t)
  f.drag([17 * 30])
  assert.deepEqual(f.wheels(), Array(15).fill(1))
  f.clear()
  f.touch('touchstart')
  f.move(8)
  f.touch('touchcancel')
  f.drag([9])
  assert.deepEqual(f.sent, [])
})

test('mouse mode presses, drags once per cell and releases where the finger left', (t) => {
  const f = fixture(t, 17, 'mouse')
  f.touch('touchstart')
  f.move(2)
  f.move(0, 131)
  f.move(17, 131)
  f.touch('touchend')
  assert.deepEqual(f.sent, [
    '\x1b[<0;13;36M',
    '\x1b[<32;14;36M',
    '\x1b[<32;14;35M',
    '\x1b[<0;14;35m',
  ])
  assert.equal(f.copies(), 0, 'an untrusted gesture never authorizes a copy')
})
