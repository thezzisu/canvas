import { test } from 'node:test'
import assert from 'node:assert/strict'
import { developerMode, viewportFit, interactiveWidget, initializeViewportPolicy, viewportPolicy, viewportReloadRequired } from '../web/src/developer-mode.ts'

test('viewport policy applies once on startup; later edits and developer disable require reload', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document')
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'document', original)
    else Reflect.deleteProperty(globalThis, 'document')
  })
  const meta = { content: '' }
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelector: () => meta } })
  developerMode.value = true; viewportFit.value = 'contain'; interactiveWidget.value = 'resizes-visual'
  initializeViewportPolicy()
  const applied = meta.content
  assert.equal(applied, 'width=device-width, initial-scale=1.0, viewport-fit=contain, interactive-widget=resizes-visual')
  assert.equal(viewportReloadRequired.value, false)
  viewportFit.value = 'cover'; interactiveWidget.value = 'resizes-content'
  initializeViewportPolicy()
  assert.equal(meta.content, applied, 'changing preferences cannot hot-switch the native IME policy')
  assert.deepEqual(viewportPolicy.value, { viewportFit: 'contain', interactiveWidget: 'resizes-visual' })
  assert.equal(viewportReloadRequired.value, true)
  viewportFit.value = 'contain'; interactiveWidget.value = 'resizes-visual'
  assert.equal(viewportReloadRequired.value, false, 'reverting pending choices cancels the reload requirement')
  developerMode.value = false
  assert.equal(viewportReloadRequired.value, true)
  assert.equal(meta.content, applied, 'turning off developer mode does not mutate the current native policy either')
})
