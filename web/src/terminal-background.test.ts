import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fillTerminalBackground } from './terminal-background.ts'

// Node has no getComputedStyle, so any computed-style read would throw here.
test('only the renderer default background, set inline by xterm, fills the card margins', () => {
  const renderer = { style: { backgroundColor: 'rgb(17, 19, 23)' } }, host = { style: { backgroundColor: '' } } as HTMLElement
  const element = { querySelector: (selector: string) => selector === '.xterm-scrollable-element' ? renderer : null } as unknown as HTMLElement
  fillTerminalBackground(element, host)
  assert.equal(host.style.backgroundColor, 'rgb(17, 19, 23)')
  renderer.style.backgroundColor = ''
  fillTerminalBackground(element, host)
  assert.equal(host.style.backgroundColor, 'rgb(17, 19, 23)', 'an unthemed renderer leaves the margins unchanged')
})
