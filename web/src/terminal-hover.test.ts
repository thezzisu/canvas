import assert from 'node:assert/strict'
import test from 'node:test'
import { bindTerminalHover } from './terminal-hover.ts'

test('hover preference and a local selection suppress only unpressed motion before xterm input', () => {
  const surface = new EventTarget(), terminal = { hasSelection: () => selected }
  let enabled = true, selected = false, reports = 0
  const dispose = bindTerminalHover(surface as HTMLElement, terminal, () => enabled)
  surface.addEventListener('mousemove', () => reports++)
  const move = (buttons = 0) => { const event = new Event('mousemove'); Object.assign(event, { buttons }); surface.dispatchEvent(event) }
  move(); assert.equal(reports, 1)
  selected = true; move(); assert.equal(reports, 1, 'hover cannot clear a local Shift selection')
  move(1); assert.equal(reports, 2, 'dragging keeps its native owner')
  selected = false; enabled = false; move(); assert.equal(reports, 2)
  move(2); assert.equal(reports, 3, 'right-drag behavior is independent of hover')
  enabled = true; move(); assert.equal(reports, 4)
  dispose(); selected = true; move(); assert.equal(reports, 5)
})
