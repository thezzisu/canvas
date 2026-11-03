import assert from 'node:assert/strict'
import test from 'node:test'
import { captureAddress } from './capture-address.ts'

function terminalRequest(base: string) {
  const request = new URL('http://private-backend:3010/api/terminal')
  request.searchParams.set('apiBase', base)
  return request
}

test('capture retains the browser HTTPS authority and public proxy mount despite a private backend Host', () => {
  assert.equal(captureAddress(terminalRequest('https://workbench.example/canvas-test/'), '/canvas-test'), 'https://workbench.example/canvas-test/')
  assert.equal(captureAddress(terminalRequest('https://workbench.example/'), undefined), 'https://workbench.example/')
})

test('capture refuses ambiguous or mismatched instance routing instead of leaking a backend address', () => {
  const request = terminalRequest('https://workbench.example/canvas-test/')
  assert.throws(() => captureAddress(request, '/different'), /does not match/u)
  assert.throws(() => captureAddress(request, undefined), /does not match/u)
  assert.throws(() => captureAddress(request, ['/canvas-test', '/other']), /Invalid/u)
  request.searchParams.append('apiBase', 'https://workbench.example/canvas-test/')
  assert.throws(() => captureAddress(request, '/canvas-test'), /Ambiguous/u)
  assert.equal(captureAddress(new URL('http://private-backend/api/terminal'), undefined), undefined, 'ordinary terminal clients need no capture context')
})
