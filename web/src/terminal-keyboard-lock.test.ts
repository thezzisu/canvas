import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { bindTerminalKeyboardLock, keyboardLockState, keyboardLockUnavailableReason } from './terminal-keyboard-lock.ts'

async function settle() { for (let index = 0; index < 4; index++) await Promise.resolve() }
function fixture(t: TestContext, options: { secure?: boolean; supported?: boolean } = {}) {
  const requests: Array<{ codes: string[]; resolve(): void; reject(): void }> = []
  let unlocks = 0
  const keyboard = {
    lock(codes: string[]) {
      return new Promise<void>((resolve, reject) => requests.push({ codes: [...codes], resolve, reject: () => reject(new Error('Denied')) }))
    },
    unlock() { unlocks++ },
  }
  const view = Object.assign(new EventTarget(), { isSecureContext: options.secure !== false,
    navigator: options.supported === false ? {} : { keyboard } })
  const document = Object.assign(new EventTarget(), { defaultView: view, fullscreenElement: {} as object | null,
    activeElement: null as object | null, visibilityState: 'visible', focused: true, hasFocus() { return this.focused } })
  const inputs: Array<{ ownerDocument: typeof document; isConnected: boolean }> = []
  const disposers: Array<() => void> = []
  function input(eligible = () => true) {
    const element = { ownerDocument: document, isConnected: true }
    inputs.push(element)
    const controller = bindTerminalKeyboardLock(element as unknown as HTMLElement, eligible)
    disposers.push(controller.dispose)
    return { element, ...controller }
  }
  async function focus(element: object | null) {
    document.activeElement = element
    document.dispatchEvent(new Event('focusout'))
    document.dispatchEvent(new Event('focusin'))
    await settle()
  }
  t.after(async () => {
    for (const dispose of disposers) dispose()
    for (const request of requests) request.reject()
    await settle()
  })
  return { document, view, requests, input, focus, unlocks: () => unlocks }
}

test('keyboard lock is unavailable on insecure origins and unsupported browsers', t => {
  const insecure = fixture(t, { secure: false })
  insecure.input()
  assert.equal(keyboardLockState.value, 'unavailable')
  assert.equal(keyboardLockUnavailableReason.value, 'insecure-context')
  assert.equal(insecure.requests.length, 0)
  const unsupported = fixture(t, { supported: false })
  unsupported.input()
  assert.equal(keyboardLockState.value, 'unavailable')
  assert.equal(keyboardLockUnavailableReason.value, 'unsupported')
  assert.equal(unsupported.requests.length, 0)
})

test('only a focused eligible input in native fullscreen requests the broad key set', async t => {
  const f = fixture(t)
  let eligible = false
  const { element } = f.input(() => eligible)
  await f.focus(element)
  assert.equal(keyboardLockState.value, 'idle')
  assert.equal(f.requests.length, 0)
  eligible = true
  f.document.fullscreenElement = null
  f.document.dispatchEvent(new Event('fullscreenchange'))
  assert.equal(f.requests.length, 0, 'page fullscreen alone is insufficient')
  f.document.fullscreenElement = {}
  f.document.dispatchEvent(new Event('fullscreenchange'))
  assert.equal(keyboardLockState.value, 'pending')
  assert.equal(f.requests.length, 1)
  const codes = f.requests[0]!.codes
  for (const code of ['KeyT', 'KeyW', 'KeyN', 'Tab', 'F12', 'ArrowLeft', 'Backspace', 'NumpadEnter']) assert(codes.includes(code))
  assert(!codes.includes('Escape'))
  assert(!codes.includes('MetaLeft'))
  assert.equal(new Set(codes).size, codes.length)
  f.requests[0]!.resolve(); await settle()
  assert.equal(keyboardLockState.value, 'active')
  await f.focus({})
  assert.equal(keyboardLockState.value, 'idle')
  assert.equal(f.unlocks(), 1, 'a settings/modal input releases terminal ownership')
})

test('clipboard focus borrowing within one task does not drop or reacquire the lock', async t => {
  const f = fixture(t)
  const { element } = f.input()
  await f.focus(element)
  f.requests[0]!.resolve(); await settle()
  f.document.activeElement = {}
  f.document.dispatchEvent(new Event('focusout'))
  f.document.dispatchEvent(new Event('focusin'))
  f.document.activeElement = element
  f.document.dispatchEvent(new Event('focusin'))
  await settle()
  assert.equal(keyboardLockState.value, 'active')
  assert.equal(f.unlocks(), 0)
  assert.equal(f.requests.length, 1)
})

test('hidden pages, window blur, fullscreen exit and unmount each release capture', async t => {
  const f = fixture(t)
  const { element, dispose } = f.input()
  await f.focus(element)
  f.requests.at(-1)!.resolve(); await settle()
  f.document.visibilityState = 'hidden'; f.document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(keyboardLockState.value, 'idle')
  assert.equal(f.unlocks(), 1)
  f.document.visibilityState = 'visible'; f.document.dispatchEvent(new Event('visibilitychange'))
  f.requests.at(-1)!.resolve(); await settle()
  f.view.dispatchEvent(new Event('blur'))
  assert.equal(f.unlocks(), 2)
  f.view.dispatchEvent(new Event('focus'))
  f.requests.at(-1)!.resolve(); await settle()
  f.document.fullscreenElement = null; f.document.dispatchEvent(new Event('fullscreenchange'))
  assert.equal(f.unlocks(), 3)
  f.document.fullscreenElement = {}; f.document.dispatchEvent(new Event('fullscreenchange'))
  f.requests.at(-1)!.resolve(); await settle()
  f.view.dispatchEvent(new Event('pagehide'))
  assert.equal(f.unlocks(), 4)
  f.document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(keyboardLockState.value, 'idle', 'a pagehide cannot reopen capture before pageshow')
  f.view.dispatchEvent(new Event('pageshow'))
  f.requests.at(-1)!.resolve(); await settle()
  dispose()
  assert.equal(keyboardLockState.value, 'idle')
  assert.equal(f.unlocks(), 5)
  f.document.dispatchEvent(new Event('fullscreenchange')); await settle()
  assert.equal(f.requests.length, 5)
})

test('denial is retried only after focus or other eligibility changes', async t => {
  const f = fixture(t)
  const { element } = f.input()
  await f.focus(element)
  f.requests[0]!.reject(); await settle()
  assert.equal(keyboardLockState.value, 'denied')
  f.document.dispatchEvent(new Event('fullscreenchange'))
  f.document.dispatchEvent(new Event('visibilitychange'))
  await f.focus(element)
  assert.equal(f.requests.length, 1, 'unchanged eligibility does not repeat a permission request')
  await f.focus(null); await f.focus(element)
  assert.equal(f.requests.length, 2)
  f.requests[1]!.resolve(); await settle()
  assert.equal(keyboardLockState.value, 'active')
})

test('replacement inputs serialize permission requests and stale grants cannot revoke the new owner', async t => {
  const f = fixture(t)
  const first = f.input()
  await f.focus(first.element)
  const second = f.input()
  first.dispose()
  await f.focus(second.element)
  assert.equal(f.requests.length, 1, 'a second lock waits for the previous promise to settle')
  f.requests[0]!.resolve(); await settle()
  assert.equal(f.requests.length, 2)
  assert.equal(keyboardLockState.value, 'pending')
  assert.equal(f.unlocks(), 2, 'cancel pending request and clean up its late grant before requesting again')
  f.requests[1]!.resolve(); await settle()
  assert.equal(keyboardLockState.value, 'active')
  assert.equal(f.unlocks(), 2, 'the stale request has no remaining callback that could unlock the new owner')
})

test('a late grant after all inputs unmount is released without another request', async t => {
  const f = fixture(t)
  const { element, dispose } = f.input()
  await f.focus(element)
  dispose()
  assert.equal(keyboardLockState.value, 'idle')
  f.requests[0]!.resolve(); await settle()
  assert.equal(f.unlocks(), 2)
  assert.equal(keyboardLockState.value, 'idle')
  assert.equal(f.requests.length, 1)
})


test('explicit eligibility refresh releases a connected input without moving focus', async t => {
  const f = fixture(t)
  let eligible = true
  const { element, refresh } = f.input(() => eligible)
  await f.focus(element)
  f.requests[0]!.resolve(); await settle()
  eligible = false
  refresh()
  assert.equal(keyboardLockState.value, 'idle')
  assert.equal(f.unlocks(), 1)
  assert.equal(f.document.activeElement, element)
  eligible = true
  refresh()
  assert.equal(f.requests.length, 2)
  f.requests[1]!.resolve(); await settle()
  assert.equal(keyboardLockState.value, 'active')
})
