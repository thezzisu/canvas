import assert from 'node:assert/strict'
import test from 'node:test'
import { bindTerminalHover, suppressHover } from './terminal-hover.ts'

test('hover filtering suppresses only unpressed motion while hover is off or a selection is local', () => {
  assert.equal(suppressHover({ buttons: 0 }, true, false), false)
  assert.equal(suppressHover({ buttons: 0 }, false, false), true)
  assert.equal(suppressHover({ buttons: 0 }, true, true), true)
  assert.equal(suppressHover({ buttons: 1 }, false, true), false)
  assert.equal(suppressHover({ buttons: 2 }, false, false), false)
})

type Listener = { capture: boolean; handle(event: MouseEvent): void }
/** Node has no DOM; this models only the capture/target/bubble order the binding relies on. */
class FakeNode {
  readonly listeners: Listener[] = []
  constructor(readonly name: string, readonly parent?: FakeNode) {}
  addEventListener(_: string, handle: Listener['handle'], options?: { capture?: boolean }) { this.listeners.push({ capture: !!options?.capture, handle }) }
  removeEventListener(_: string, handle: Listener['handle']) { this.listeners.splice(this.listeners.findIndex(item => item.handle === handle) >>> 0, 1) }
  contains(other: unknown) { for (let node = other as FakeNode | undefined; node; node = node.parent) if (node === this) return true; return false }
}
function dispatch(target: FakeNode, buttons = 0) {
  const ancestors: FakeNode[] = []
  for (let node = target.parent; node; node = node.parent) ancestors.unshift(node)
  let stopped = false, immediate = false
  const event = { buttons, target, stopPropagation: () => { stopped = true }, stopImmediatePropagation: () => { stopped = immediate = true } } as unknown as MouseEvent
  const phases: Array<[FakeNode, boolean | undefined]> = [...ancestors.map(node => [node, true] as [FakeNode, boolean]), [target, undefined], ...ancestors.reverse().map(node => [node, false] as [FakeNode, boolean])]
  for (const [node, capture] of phases) {
    if (stopped) return
    for (const listener of [...node.listeners]) if (capture === undefined || listener.capture === capture) { if (immediate) return; listener.handle(event) }
  }
}

test('link detection on the screen sees motion that xterm mouse reporting does not', () => {
  const order: string[] = []
  const surface = new FakeNode('surface'), xterm = new FakeNode('xterm', surface), screen = new FakeNode('screen', xterm)
  const canvas = new FakeNode('canvas', screen), scrollbar = new FakeNode('scrollbar', xterm)
  // xterm registers the Linkifier on the screen and mouse reporting on `.xterm` before Canvas binds.
  for (const node of [xterm, screen, canvas, scrollbar]) node.addEventListener('mousemove', () => order.push(node.name))
  let enabled = false, selected = false
  const terminal = { hasSelection: () => selected, element: { querySelector: () => screen } as unknown as HTMLElement }
  const dispose = bindTerminalHover(surface as unknown as HTMLElement, terminal, () => enabled)
  dispatch(canvas)
  assert.deepEqual(order.splice(0), ['canvas', 'screen'], 'the Linkifier on the screen still receives hover')
  dispatch(scrollbar)
  assert.deepEqual(order.splice(0), [], 'motion outside the screen stops before xterm')
  dispatch(canvas, 1)
  assert.deepEqual(order.splice(0), ['canvas', 'screen', 'xterm'], 'dragging keeps its native owner')
  enabled = true
  dispatch(canvas)
  assert.deepEqual(order.splice(0), ['canvas', 'screen', 'xterm'], 'enabled hover reaches xterm reporting')
  selected = true
  dispatch(canvas)
  assert.deepEqual(order.splice(0), ['canvas', 'screen'], 'hover cannot clear a local Shift selection')
  dispose()
  dispatch(canvas); dispatch(scrollbar)
  assert.deepEqual(order.splice(0), ['canvas', 'screen', 'xterm', 'scrollbar', 'xterm'])
})
