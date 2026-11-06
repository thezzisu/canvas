import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeEditorAuthority } from './editor-target.ts'

test('editor targets retain only validated public address fields', () => {
  assert.deepEqual(sanitizeEditorAuthority({ hostName: '[2001:db8::10]', user: 'dev', port: 2222,
    identityFile: '/fixture/private-key', proxyCommand: 'fixture-token' }), { hostName: '2001:db8::10', user: 'dev', port: 2222 })
  for (const hostName of ['192.0.2.10', 'workstation.example', 'ssh-alias', 'host_with_underscore', '::1'])
    assert.equal(sanitizeEditorAuthority({ hostName }).hostName, hostName)
})

test('malformed editor targets cannot become external editor requests', () => {
  for (const hostName of ['', '-option', 'host name', 'host/path', 'user@host', 'host:2222', '::1]/other', '::1]@other', '[:::]', '\nlocalhost'])
    assert.throws(() => sanitizeEditorAuthority({ hostName }))
  for (const user of ['', '-option', 'user name', 'user@host', 12])
    assert.throws(() => sanitizeEditorAuthority({ hostName: 'host', user }))
  for (const port of [0, 65536, 1.5, NaN, '22'])
    assert.throws(() => sanitizeEditorAuthority({ hostName: 'host', port }))
  for (const value of [null, undefined, {}, { hostName: 42 }]) assert.throws(() => sanitizeEditorAuthority(value))
})
