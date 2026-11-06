import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkPwaRegistration, pwaUpdateActions } from './pwa-update.ts'

class WorkerFixture extends EventTarget {
  state: ServiceWorkerState = 'installing'
  listeners = 0
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    this.listeners++; super.addEventListener(type, listener)
  }
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    this.listeners--; super.removeEventListener(type, listener)
  }
  change(state: ServiceWorkerState) { this.state = state; this.dispatchEvent(new Event('statechange')) }
}
function registrationFixture() {
  const registration = {
    installing: null as ServiceWorker | null,
    waiting: null as ServiceWorker | null,
    calls: 0,
    async update() { registration.calls++; return registration as unknown as ServiceWorkerRegistration },
  }
  return registration
}

test('manual checking calls the native update API without activating or reloading', async () => {
  const registration = registrationFixture()
  assert.equal(await checkPwaRegistration(registration), false)
  assert.equal(registration.calls, 1)
  registration.waiting = new WorkerFixture() as unknown as ServiceWorker
  assert.equal(await checkPwaRegistration(registration), true)
  assert.equal(registration.calls, 1, 'an existing waiting update needs no second check')
})

test('manual checking waits for installation rather than reporting no update early', async () => {
  const registration = registrationFixture(), worker = new WorkerFixture()
  registration.update = async () => {
    registration.calls++; registration.installing = worker as unknown as ServiceWorker
    return registration as unknown as ServiceWorkerRegistration
  }
  let settled = false
  const check = checkPwaRegistration(registration).then(value => { settled = true; return value })
  await Promise.resolve(); await Promise.resolve()
  assert.equal(settled, false); assert.equal(worker.listeners, 1)
  registration.waiting = registration.installing; registration.installing = null
  worker.change('installed')
  assert.equal(await check, true)
  assert.equal(worker.listeners, 0, 'installation listener is removed once settled')
})

test('manual checking joins an existing installation and reports native failures', async () => {
  const registration = registrationFixture(), worker = new WorkerFixture()
  registration.installing = worker as unknown as ServiceWorker
  const failed = assert.rejects(checkPwaRegistration(registration), /installation failed/)
  assert.equal(registration.calls, 0)
  worker.change('redundant'); await failed
  assert.equal(worker.listeners, 0)
  registration.installing = null
  registration.update = async () => { throw new Error('Offline') }
  await assert.rejects(checkPwaRegistration(registration), /Offline/)
})

test('manual checking observes workers that finished before listener registration', async () => {
  const registration = registrationFixture(), worker = new WorkerFixture()
  worker.state = 'activated'
  registration.installing = worker as unknown as ServiceWorker
  assert.equal(await checkPwaRegistration(registration), false, 'first installation need not leave a waiting update')
  assert.equal(worker.listeners, 0)
})

test('a worker activated by another tab only notifies; user action alone can reload', async () => {
  let reloads = 0, notices = 0, activations = 0, waiting = true
  const first = pwaUpdateActions({ waiting: () => waiting, activate: async () => { activations++ },
    reload: () => { reloads++ }, notify: () => { notices++ } })
  first.activated()
  assert.equal(reloads, 0); assert.equal(notices, 1)
  await first.apply()
  assert.equal(reloads, 0); assert.equal(activations, 1)
  first.activated()
  assert.equal(reloads, 1)
  waiting = false
  const second = pwaUpdateActions({ waiting: () => waiting, activate: async () => { assert.fail('Already active worker') },
    reload: () => { reloads++ }, notify: () => { notices++ } })
  second.activated(); assert.equal(reloads, 1)
  await second.apply(); assert.equal(reloads, 2)
})

test('a rejected update leaves later external activations non-disruptive', async () => {
  let reloads = 0, notices = 0
  const update = pwaUpdateActions({ waiting: () => true, activate: async () => { throw new Error('Offline') },
    reload: () => { reloads++ }, notify: () => { notices++ } })
  await assert.rejects(update.apply(), /Offline/u)
  update.activated()
  assert.equal(reloads, 0); assert.equal(notices, 1)
})
