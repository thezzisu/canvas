import assert from 'node:assert/strict'
import test from 'node:test'

// Exercise the real effects module with private in-memory browser primitives.
// Browser acceptance separately verifies native Web Locks across actual tabs.
test('notification runtime caches are bounded and preserve per-backend delivery semantics', async t => {
  await import('vue')
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const replace = (name: string, value: unknown) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value })
  }
  const values = new Map<string, string>([
    ['canvas:notifications:delivered:retired-boot', '{}'], ['canvas:notifications:focus:retired-boot', '{}'],
    ['canvas:notifications:sound', 'true'], ['canvas:notifications:badge-owner', '"existing-badge"'], ['unrelated', 'keep'],
  ])
  let blocked = false, foreground = true, now = 1000, sounds = 0, queryAdvance = 0
  const shown: Array<{ title: string; options: NotificationOptions }> = []
  const alive = new Set<string>(), queues = new Map<string, Promise<unknown>>()
  replace('localStorage', {
    get length() { return values.size }, key: (index: number) => [...values.keys()][index] ?? null,
    getItem(key: string) { if (blocked) throw Error('Storage blocked'); return values.get(key) ?? null },
    setItem(key: string, value: string) { if (blocked) throw Error('Storage blocked'); values.set(key, value) },
    removeItem(key: string) { values.delete(key) },
  })
  replace('document', { hasFocus: () => foreground, hidden: false })
  replace('location', { href: 'https://fixture.invalid/' })
  replace('Notification', { permission: 'granted' })
  replace('navigator', {
    locks: {
      request(name: string, callback: () => unknown) {
        const next = (queues.get(name) || Promise.resolve()).then(callback)
        queues.set(name, next.catch(() => {})); return next
      },
      query: async () => { now += queryAdvance; queryAdvance = 0; return { held: [...alive].map(owner => ({ name: `canvas:notifications:owner:${owner}` })) } },
    },
    serviceWorker: { getRegistration: async () => ({ active: {}, showNotification: async (title: string, options: NotificationOptions) => { shown.push({ title, options }) } }) },
  })
  replace('AudioContext', class {
    state = 'running'; currentTime = 0; destination = {}
    resume() { return Promise.resolve() }
    close() { return Promise.resolve() }
    createOscillator() { return { frequency: { setValueAtTime() {} }, connect() {}, disconnect() {}, start() { sounds++ }, stop() {} } }
    createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {} } }
  })
  t.mock.method(Date, 'now', () => now)
  t.after(() => { for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name) } })
  const settings = await import('./notification-settings')
  const effects = await import('./notification-effects')
  settings.notificationSystemEnabled.value = true
  settings.notificationSoundEnabled.value = true
  await settings.unlockNotificationSound()
  const event = (id: string) => ({ id, sourceId: 'source', windowId: 'window', paneId: 'pane', kind: 'done' as const, title: 'Fixture' })
  const deliver = (backend: string, id: string, options: { quiet?: boolean; suppressSystem?: boolean; valid?(): boolean } = {}) =>
    effects.deliverNotificationEffects(backend, event(id), { title: 'Fixture', body: '', url: 'https://fixture.invalid/', valid: () => true, ...options })
  const ledger = () => JSON.parse(values.get('canvas:notifications:effects') || '{}')
  const reset = () => { values.delete('canvas:notifications:effects'); values.delete('canvas:notifications:focus'); shown.length = 0; sounds = 0; now = 1000; queryAdvance = 0; alive.clear(); blocked = false; foreground = true }

  await t.test('retires only obsolete per-startup cache keys', () => {
    assert(!values.has('canvas:notifications:delivered:retired-boot'))
    assert(!values.has('canvas:notifications:focus:retired-boot'))
    assert.equal(values.get('canvas:notifications:sound'), 'true')
    assert.equal(values.get('canvas:notifications:badge-owner'), '"existing-badge"')
    assert.equal(values.get('unrelated'), 'keep')
  })
  await t.test('same-backend aliases deliver each channel once, while other backends keep independent cooldowns', async () => {
    reset()
    await Promise.all([deliver('backend-a', 'shared'), deliver('backend-a', 'shared')])
    assert.equal(sounds, 1); assert.equal(shown.length, 1)
    await deliver('backend-b', 'shared')
    assert.equal(sounds, 2); assert.equal(shown.length, 2)
    await deliver('backend-a', 'second')
    assert.equal(sounds, 2); assert.equal(shown.length, 3)
    now += 750; await deliver('backend-a', 'third')
    assert.equal(sounds, 3)
    assert.deepEqual(Object.keys(ledger().sounds), ['backend-a'])
  })
  await t.test('a muted tab does not consume a later audio delivery', async () => {
    reset(); settings.notificationSoundEnabled.value = false
    await deliver('backend-a', 'separate-channels')
    assert.equal(shown.length, 1); assert.equal(sounds, 0)
    settings.notificationSoundEnabled.value = true; await settings.unlockNotificationSound()
    await deliver('backend-a', 'separate-channels')
    assert.equal(shown.length, 1); assert.equal(sounds, 1)
  })
  await t.test('the cooldown begins when sound plays, after a delayed owner lookup', async () => {
    reset(); alive.add('foreground')
    await effects.syncNotificationFocus('backend-a', 'foreground')
    queryAdvance = 1000
    await deliver('backend-a', 'after-delay')
    assert.equal(ledger().sounds['backend-a'], 2000)
    now += 500; await deliver('backend-a', 'next')
    assert.equal(sounds, 1)
  })
  await t.test('focus transfer is backend-scoped, clears stale attention and rejects late blur from the previous owner', async () => {
    reset(); alive.add('old'); alive.add('new')
    await effects.syncNotificationFocus('backend-a', 'old', { sourceId: 'source', windowId: 'window', paneId: 'pane' })
    await deliver('backend-b', 'other-backend')
    assert.equal(shown.length, 1)
    await effects.syncNotificationFocus('backend-a', 'new')
    await effects.syncNotificationFocus('backend-a', 'old', undefined, () => false)
    assert.deepEqual(JSON.parse(values.get('canvas:notifications:focus')!), { backend: 'backend-a', owner: 'new' })
    await deliver('backend-a', 'no-pane')
    assert.equal(shown.length, 2)
    await effects.syncNotificationFocus('backend-a', 'new', { sourceId: 'source', windowId: 'window', paneId: 'pane' })
    await deliver('backend-a', 'attended')
    assert.equal(shown.length, 2)
    alive.delete('new'); await deliver('backend-a', 'dead-owner')
    assert.equal(shown.length, 3)
  })
  await t.test('many backend restarts create one bounded ledger and bounded cooldown map', async () => {
    reset()
    for (let index = 0; index < 300; index++) await deliver(`backend-${index}`, `event-${index}`)
    assert.equal(ledger().events.length, 256); assert.equal(Object.keys(ledger().sounds).length, 256)
    assert.deepEqual([...values.keys()].filter(key => key.startsWith('canvas:notifications:effects')), ['canvas:notifications:effects'])
    assert(![...values.keys()].some(key => key.startsWith('canvas:notifications:delivered:') || key.startsWith('canvas:notifications:focus:')))
    now += 750; await deliver('next', 'quiet', { quiet: true })
    assert.deepEqual(ledger().sounds, {})
    assert.equal(ledger().events.length, 256)
  })
  await t.test('invalid or future timestamps do not permanently silence a backend', async () => {
    reset()
    values.set('canvas:notifications:effects', JSON.stringify({ events: [{ backend: 'backend-a', id: 'past' }], sounds: { 'backend-a': now + 999999 } }))
    await deliver('backend-a', 'new'); assert.equal(sounds, 1)
    now -= 500; await deliver('backend-a', 'after-clock-change'); assert.equal(sounds, 2)
  })
  await t.test('blocked storage and stale work fail before optional effects run', async () => {
    reset(); blocked = true
    await deliver('backend-a', 'blocked')
    assert.equal(sounds, 0); assert.equal(shown.length, 0)
    blocked = false; values.set('canvas:notifications:effects', '{invalid')
    await deliver('backend-a', 'malformed')
    assert.equal(sounds, 0); assert.equal(shown.length, 0)
    values.delete('canvas:notifications:effects')
    await deliver('backend-a', 'stale', { valid: () => false })
    assert.equal(sounds, 0); assert.equal(shown.length, 0); assert.equal(values.has('canvas:notifications:effects'), false)
  })
})
