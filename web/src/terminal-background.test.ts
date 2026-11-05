import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fillTerminalBackground } from './terminal-background.ts'

test('only the renderer default background fills margins, regardless of sampled program rows', () => {
  const renderer = {} as Element, sampledRows = { children: [{ style: { backgroundColor: 'rgb(55, 55, 55)' } }] }
  const queries: string[] = []
  const element = { querySelector(selector: string) { queries.push(selector); return selector === '.xterm-scrollable-element' ? renderer : sampledRows } } as unknown as HTMLElement
  const host = { style: { backgroundColor: '' } } as unknown as HTMLElement
  const previous = globalThis.getComputedStyle
  globalThis.getComputedStyle = (() => ({ backgroundColor: 'rgb(11, 11, 11)' } as unknown as CSSStyleDeclaration)) as typeof getComputedStyle
  try {
    fillTerminalBackground(element, host)
    assert.equal(host.style.backgroundColor, 'rgb(11, 11, 11)')
    assert.deepEqual(queries, ['.xterm-scrollable-element'])
  } finally { globalThis.getComputedStyle = previous }
})

test('a transparent or missing renderer keeps the card background', () => {
  const previous = globalThis.getComputedStyle, renderer = {} as Element
  globalThis.getComputedStyle = (() => ({ backgroundColor: 'rgba(0, 0, 0, 0)' } as unknown as CSSStyleDeclaration)) as typeof getComputedStyle
  try {
    const host = { style: { backgroundColor: 'rgb(18, 19, 23)' } } as unknown as HTMLElement
    fillTerminalBackground({ querySelector: () => renderer } as unknown as HTMLElement, host)
    fillTerminalBackground({ querySelector: () => null } as unknown as HTMLElement, host)
    assert.equal(host.style.backgroundColor, 'rgb(18, 19, 23)')
  } finally { globalThis.getComputedStyle = previous }
})
