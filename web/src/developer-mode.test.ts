import { test } from 'node:test'
import assert from 'node:assert/strict'
import { developerMode, viewportFit, interactiveWidget, initializeViewportPolicy, viewportPolicy, viewportReloadRequired } from './developer-mode.ts'

test('viewport policy applies once on startup; later edits and developer disable require reload', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document')
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'document', original)
    else Reflect.deleteProperty(globalThis, 'document')
  })
  const meta = { content: '' }, root = { dataset: {} as Record<string, string> }
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelector: () => meta, documentElement: root } })
  assert.deepEqual(viewportPolicy.value, { viewportFit: 'cover', interactiveWidget: 'resizes-content' })
  developerMode.value = true; viewportFit.value = 'contain'; interactiveWidget.value = 'overlays-content'
  initializeViewportPolicy()
  const applied = meta.content
  assert.equal(applied, 'width=device-width, initial-scale=1.0, viewport-fit=contain, interactive-widget=overlays-content')
  assert.equal(viewportReloadRequired.value, false)
  assert.equal(root.dataset.interactiveWidget, 'overlays-content')
  viewportFit.value = 'cover'; interactiveWidget.value = 'resizes-visual'
  initializeViewportPolicy()
  assert.equal(meta.content, applied, 'changing preferences cannot hot-switch the native IME policy')
  assert.deepEqual(viewportPolicy.value, { viewportFit: 'contain', interactiveWidget: 'overlays-content' })
  assert.equal(root.dataset.interactiveWidget, 'overlays-content', 'pending choices do not hot-switch CSS sizing')
  assert.equal(viewportReloadRequired.value, true)
  viewportFit.value = 'contain'; interactiveWidget.value = 'overlays-content'
  assert.equal(viewportReloadRequired.value, false, 'reverting pending choices cancels the reload requirement')
  developerMode.value = false
  assert.equal(viewportReloadRequired.value, true)
  assert.equal(meta.content, applied, 'turning off developer mode does not mutate the current native policy either')
})
