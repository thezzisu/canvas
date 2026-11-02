import test from 'node:test'
import assert from 'node:assert/strict'
import { bindTerminalMouseDefaults } from './terminal-mouse-defaults.ts'

test('native right and middle clicks suppress browser defaults without touching input or paste events', () => {
  const view = new EventTarget(), document = Object.assign(new EventTarget(), { defaultView: view }), surface = Object.assign(new EventTarget(), { ownerDocument: document })
  let active = true, downstream = 0
  const dispose = bindTerminalMouseDefaults(surface as unknown as HTMLElement, () => active)
  const send = (type: string, button = 2) => {
    const event = new Event(type, { cancelable: true })
    Object.defineProperty(event, 'button', { value: button })
    surface.dispatchEvent(event)
    return event.defaultPrevented
  }
  surface.addEventListener('contextmenu', () => downstream++)
  surface.addEventListener('auxclick', () => downstream++)
  assert(send('contextmenu'))
  assert(send('auxclick', 1))
  assert.equal(downstream, 0, 'xterm cannot relocate its hidden textarea for browser paste')
  assert(send('mousedown', 2), 'right press cannot focus xterm or reach native input')
  assert(!send('mousedown', 0)); assert(!send('mouseup'))
  assert(!send('paste')); assert(!send('keydown')); assert(!send('auxclick', 2))
  assert(!send('pointerdown', 1)); assert(!send('mousedown', 1))
  assert(send('paste'), 'primary-selection paste from the same native middle gesture is consumed')
  assert(!send('paste'), 'the guard consumes only the associated paste')
  send('pointerdown', 1); send('keydown')
  assert(!send('paste'), 'keyboard paste begins a new explicit input gesture')
  send('pointerdown', 1); send('pointerdown', 0)
  assert(!send('paste'), 'another pointer gesture cancels middle-paste ownership')
  send('pointerdown', 1); document.dispatchEvent(new Event('pointerdown'))
  assert(!send('paste'), 'an outside pointer gesture also clears middle-paste ownership')
  for (const [target, type] of [[view, 'blur'], [document, 'visibilitychange']] as const) {
    send('pointerdown', 1); target.dispatchEvent(new Event(type))
    assert(!send('paste'), 'returning from OS clipboard UI cannot consume a new paste')
  }
  active = false
  assert(!send('contextmenu')); assert(!send('auxclick', 1))
  assert.equal(downstream, 3)
  active = true
  dispose()
  assert(!send('contextmenu')); assert(!send('auxclick', 1))
  assert.equal(downstream, 5)
})
