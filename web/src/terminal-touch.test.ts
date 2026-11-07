import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import type { Terminal } from '@xterm/xterm'
import { bindTerminalTouch } from './terminal-touch.ts'

class WheelFixture extends Event {
  static readonly DOM_DELTA_LINE = 1
  readonly clientX: number
  readonly clientY: number
  readonly deltaY: number
  readonly deltaMode: number
  constructor(type: string, init: WheelEventInit) {
    super(type, init)
    this.clientX = init.clientX ?? 0; this.clientY = init.clientY ?? 0
    this.deltaY = init.deltaY ?? 0; this.deltaMode = init.deltaMode ?? 0
  }
}
function fixture(t: TestContext, lineHeight = 17, mouse = true, alternate = false) {
  const view = new EventTarget(), surface = new EventTarget(), wheels: WheelFixture[] = [], history: number[] = []
  const element = Object.assign(new EventTarget(), {
    querySelector: () => ({ getBoundingClientRect: () => ({ height: lineHeight * 24 }) }),
  })
  element.addEventListener('wheel', event => wheels.push(event as WheelFixture))
  const globals = new Map(['window', 'WheelEvent'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  Object.defineProperty(globalThis, 'window', { configurable: true, value: view })
  Object.defineProperty(globalThis, 'WheelEvent', { configurable: true, value: WheelFixture })
  let focused = 0
  const terminal = { element, rows: 24, modes: { mouseTrackingMode: mouse ? 'drag' : 'none' },
    buffer: { active: { type: alternate ? 'alternate' : 'normal' } }, scrollLines: (lines: number) => history.push(lines),
    parser: { registerCsiHandler: () => ({ dispose() {} }), registerEscHandler: () => ({ dispose() {} }) },
  } as unknown as Terminal
  const dispose = bindTerminalTouch(surface as HTMLElement, terminal, {
    active: () => true, mode: () => 'scroll', focus: () => { focused++ }, copyGesture: () => assert.fail('scroll cannot copy'),
    suppressInput: action => action(),
  })
  t.after(() => {
    dispose()
    for (const [name, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  })
  let y = 600
  function touch(type: string) {
    const event = new Event(type, { cancelable: true })
    Object.assign(event, { touches: type === 'touchend' || type === 'touchcancel' ? [] : [{ identifier: 1, clientX: 120, clientY: y }] })
    surface.dispatchEvent(event)
    return event.defaultPrevented
  }
  function drag(deltas: number[]) {
    assert(touch('touchstart'))
    for (const delta of deltas) { y -= delta; assert(touch('touchmove')) }
    assert(touch('touchend'))
  }
  return { wheels, history, drag, focused: () => focused, clear: () => { wheels.length = 0; history.length = 0 }, touch, move: (delta: number) => { y -= delta; touch('touchmove') } }
}

test('mobile scrolling reports one line-unit wheel step per crossed cell independent of event chunking', t => {
  const f = fixture(t)
  for (const deltas of [[120], Array(6).fill(20), Array(12).fill(10)]) {
    f.clear(); f.drag(deltas)
    assert.equal(f.wheels.length, 7, '120 CSS pixels cross seven visible 17px cells')
    assert(f.wheels.every(event => event.deltaMode === 1 && event.deltaY === 1))
    assert(f.wheels.every(event => event.clientX === 120 && event.clientY <= 600), 'the direct mode keeps the finger hit coordinates')
  }
  assert.equal(f.focused(), 3, 'one focus per gesture, not per wheel report')
  assert.deepEqual(f.history, [])
})

test('fractional scaled cell heights retain remainder and reverse without inventing wheel steps', t => {
  const f = fixture(t, 17.25)
  f.drag([6, -6, 12, 5.25, -17.25])
  assert.deepEqual(f.wheels.map(event => event.deltaY), [1, -1])
  f.clear(); f.drag([23, 23, 23])
  assert.equal(f.wheels.length, 4)
  f.clear(); f.drag([69])
  assert.equal(f.wheels.length, 4)
})

test('normal buffers without mouse reporting retain local history scrolling', t => {
  const f = fixture(t, 17, false)
  f.drag([68, -34])
  assert.deepEqual(f.history, [4, -2])
  assert.deepEqual(f.wheels, [])
})

test('alternate buffers keep xterm wheel handling and bound individual bursts like the touchpad', t => {
  const f = fixture(t, 17, false, true)
  f.drag([17 * 30])
  assert.equal(f.wheels.length, 15)
  assert(f.wheels.every(event => event.deltaMode === 1 && event.deltaY === 1))
  assert.deepEqual(f.history, [])
  f.clear(); f.touch('touchstart'); f.move(8); f.touch('touchcancel'); f.drag([9])
  assert.deepEqual(f.wheels, [], 'cancellation does not carry partial distance into a new gesture')
})
