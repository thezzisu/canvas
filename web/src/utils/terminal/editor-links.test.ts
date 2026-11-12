import { test } from 'node:test'
import assert from 'node:assert/strict'
import { vscodeDirectoryUri } from './editor-links.ts'

function decodeAuthority(uri: URL) {
  const hex = uri.pathname.split('/')[1]!.slice('ssh-remote+'.length)
  return JSON.parse(
    new TextDecoder().decode(Uint8Array.from(hex.match(/../g)!, (byte) => parseInt(byte, 16))),
  )
}

test('browser editor links preserve the existing VS Code host and literal Unicode directory format', () => {
  const path = "/workspace/开发/项目 #?/100% 'final'"
  const authority = { hostName: '192.0.2.10', user: 'dev', port: 2222 }
  const uri = new URL(vscodeDirectoryUri(authority, path))
  assert.equal(uri.protocol, 'vscode:')
  assert.equal(uri.hostname, 'vscode-remote')
  assert.equal(uri.search, '')
  assert.equal(uri.hash, '')
  assert.deepEqual(decodeAuthority(uri), authority)
  assert.equal(decodeURIComponent(uri.pathname.slice(uri.pathname.indexOf('/', 1))), path)
  assert(!uri.href.includes(' '))
  assert(!uri.href.includes("'"))
  assert.deepEqual(
    decodeAuthority(new URL(vscodeDirectoryUri({ hostName: '[2001:db8::10]' }, '/'))),
    { hostName: '2001:db8::10' },
  )
})

test('browser formatting strips unrelated fields and refuses unsafe directory inputs', () => {
  const uri = new URL(
    vscodeDirectoryUri(
      { hostName: 'host.example', user: 'dev', secret: 'fixture-secret' },
      '/project',
    ),
  )
  assert.deepEqual(decodeAuthority(uri), { hostName: 'host.example', user: 'dev' })
  for (const path of [
    'project',
    '../project',
    '/tmp/\ncontrol',
    '/tmp/\0bad',
    '/tmp/\ud800bad',
    '/' + 'a'.repeat(8192),
  ])
    assert.throws(() => vscodeDirectoryUri({ hostName: 'host' }, path))
  assert.throws(() => vscodeDirectoryUri({ hostName: '-option' }, '/project'))
})
