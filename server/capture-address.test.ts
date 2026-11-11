import assert from 'node:assert/strict'
import test from 'node:test'
import type { IncomingMessage } from 'node:http'
import { captureAddress, captureRequestBase } from './capture-address.ts'

function terminalRequest(base: string) {
  const request = new URL('http://private-backend:3010/api/terminal')
  request.searchParams.set('apiBase', base)
  return request
}

test('capture retains the browser HTTPS authority and public proxy mount despite a private backend Host', () => {
  assert.equal(
    captureAddress(terminalRequest('https://workbench.example/canvas-test/'), '/canvas-test'),
    'https://workbench.example/canvas-test/',
  )
  assert.equal(
    captureAddress(terminalRequest('https://workbench.example/'), undefined),
    'https://workbench.example/',
  )
})

test('capture refuses ambiguous or mismatched instance routing instead of leaking a backend address', () => {
  const request = terminalRequest('https://workbench.example/canvas-test/')
  assert.throws(() => captureAddress(request, '/different'), /does not match/u)
  assert.throws(() => captureAddress(request, undefined), /does not match/u)
  assert.throws(() => captureAddress(request, ['/canvas-test', '/other']), /Invalid/u)
  request.searchParams.append('apiBase', 'https://workbench.example/canvas-test/')
  assert.throws(() => captureAddress(request, '/canvas-test'), /Ambiguous/u)
  assert.equal(
    captureAddress(new URL('http://private-backend/api/terminal'), undefined),
    undefined,
    'ordinary terminal clients need no capture context',
  )
})

test('proxy requests derive one canonical viewer base from preserved or forwarded authority', () => {
  const request = (headers: IncomingMessage['headers']) =>
    ({ headers, socket: {} }) as IncomingMessage
  assert.equal(
    captureRequestBase(request({ host: 'local.test:3010' })).href,
    'http://local.test:3010/',
  )
  assert.equal(
    captureRequestBase(
      request({
        host: 'public.test',
        'x-forwarded-proto': 'https',
        'x-forwarded-prefix': '/canvas/',
      }),
    ).href,
    'https://public.test/canvas/',
  )
  assert.equal(
    captureRequestBase(
      request({
        host: 'private:3010',
        'x-forwarded-host': 'public.test',
        'x-forwarded-proto': 'https',
        'x-forwarded-prefix': '/canvas',
      }),
    ).href,
    'https://public.test/canvas/',
  )
  for (const headers of [
    { host: 'one.test,two.test' },
    { host: 'user@host.test' },
    { host: 'host.test/path' },
    { host: 'host.test', 'x-forwarded-host': ['one.test', 'two.test'] },
    { host: 'host.test', 'x-forwarded-proto': 'https,http' },
    { host: 'host.test', 'x-forwarded-prefix': '/one/../two' },
  ])
    assert.throws(() => captureRequestBase(request(headers)), /Invalid|canonical/u)
})
