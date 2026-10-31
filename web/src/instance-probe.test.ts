import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { effectScope, ref } from 'vue'
import { probeInstance, useInstanceProbe } from './instance-probe.ts'

const build = { version: '1.2.3', revision: 'a'.repeat(40), dirty: false }
const response = () => Response.json({ authenticated: false, username: 'fixture', server: build })

test('draft probes preserve the explicit base and never carry browser or saved account credentials', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const request: typeof fetch = async (url, init) => { requests.push({ url: String(url), init }); return response() }
  assert.deepEqual(await probeInstance(' https://canvas.example/prefix ', new AbortController().signal, request), build)
  assert.equal(requests[0]?.url, 'https://canvas.example/prefix/api/session')
  assert.equal(requests[0]?.init?.credentials, 'omit')
  assert.equal(requests[0]?.init?.redirect, 'error')
  assert.equal(requests[0]?.init?.cache, 'no-store')
  assert.equal(new Headers(requests[0]?.init?.headers).has('Authorization'), false)
  await assert.rejects(probeInstance('https://user:DUMMY_PASSWORD@canvas.example/', new AbortController().signal, request))
  assert.equal(requests.length, 1)
})

test('a connection probe must receive a valid Canvas session and server build, not a static fallback', async () => {
  for (const body of [{}, { authenticated: false }, { authenticated: false, server: { ...build, revision: 'unknown' } }])
    await assert.rejects(probeInstance('https://canvas.example/', new AbortController().signal, async () => Response.json(body)))
  await assert.rejects(probeInstance('https://canvas.example/', new AbortController().signal, async () => new Response('<html>frontend</html>')))
  await assert.rejects(probeInstance('https://canvas.example/', new AbortController().signal, async () => new Response('', { status: 503 })))
})

test('editing, disabling and closing a draft cancel stale probes and invalidate readiness immediately', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls: Array<{ url: string; signal: AbortSignal; finish: (response: Response) => void }> = []
  t.mock.method(globalThis, 'fetch', (url: URL, init: RequestInit) => new Promise<Response>(finish => {
    calls.push({ url: String(url), signal: init.signal!, finish })
  }))
  const scope = effectScope(), address = ref('https://one.example/'), enabled = ref(true)
  const probe = scope.run(() => useInstanceProbe(address, enabled))!
  t.after(() => scope.stop())
  t.mock.timers.tick(449); assert.equal(calls.length, 0)
  address.value = 'https://two.example/'; t.mock.timers.tick(450)
  assert.equal(calls.length, 1); assert.equal(calls[0]?.url, 'https://two.example/api/session')
  address.value = 'https://three.example/'; assert.equal(calls[0]?.signal.aborted, true)
  calls[0]!.finish(response()); await setImmediate(); assert.equal(probe.ready.value, false)
  t.mock.timers.tick(450); calls[1]!.finish(response()); await setImmediate()
  assert.equal(probe.ready.value, true); assert.equal(probe.result.value?.base, 'https://three.example/')
  address.value = 'not a URL'; assert.equal(probe.ready.value, false); assert.equal(probe.result.value, undefined)
  address.value = 'https://four.example/'; t.mock.timers.tick(450); enabled.value = false
  assert.equal(calls[2]?.signal.aborted, true); calls[2]!.finish(response()); await setImmediate()
  assert.equal(probe.ready.value, false); assert.equal(probe.pending.value, false)
  enabled.value = true; t.mock.timers.tick(450); scope.stop(); assert.equal(calls[3]?.signal.aborted, true)
})
