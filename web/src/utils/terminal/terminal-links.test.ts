import assert from 'node:assert/strict'
import test from 'node:test'
import type { WindowContentScan } from '../../../../shared/window-content.ts'
import {
  activateTerminalLink,
  publicWebUrl,
  scannedFile,
  terminalLinkTarget,
} from './terminal-links.ts'

test('terminal hyperlinks resolve web and source file targets', () => {
  assert.deepEqual(terminalLinkTarget('https://example.com/a?b#c'), {
    kind: 'web',
    url: 'https://example.com/a?b#c',
    loopback: false,
  })
  assert.deepEqual(terminalLinkTarget('http://example.com'), {
    kind: 'web',
    url: 'http://example.com/',
    loopback: false,
  })
  for (const local of [
    'http://localhost:3000/',
    'http://app.localhost/',
    'http://127.0.0.1:8080/x',
    'http://[::1]:5173/',
    'http://0.0.0.0/',
  ])
    assert.equal((terminalLinkTarget(local) as { loopback: boolean }).loopback, true, local)
  assert.deepEqual(terminalLinkTarget('file:///work/src/app.ts'), {
    kind: 'file',
    path: '/work/src/app.ts',
  })
  assert.deepEqual(
    terminalLinkTarget('file://build-host/work/app.ts'),
    { kind: 'file', path: '/work/app.ts' },
    'the OSC 8 host never selects another machine',
  )
  assert.deepEqual(terminalLinkTarget('file:///work/My%20Notes/%E6%96%87%E4%BB%B6.md'), {
    kind: 'file',
    path: '/work/My Notes/文件.md',
  })
  assert.deepEqual(terminalLinkTarget('file:///work/a%2F..%2Fb.txt'), {
    kind: 'file',
    path: '/work/b.txt',
  })
  assert.deepEqual(terminalLinkTarget('file:///srv/app.ts#L12'), {
    kind: 'file',
    path: '/srv/app.ts',
  })
  assert.deepEqual(
    terminalLinkTarget('file:///srv/dir/'),
    { kind: 'file', path: '/srv/dir/' },
    'normalized like the server scan',
  )
  assert.deepEqual(
    terminalLinkTarget('file:///srv/./a/../b/.'),
    { kind: 'file', path: '/srv/b/' },
    'URL dot segments resolve as on the server',
  )
})

test('unsafe or unknown hyperlinks are ignored', () => {
  for (const uri of [
    'mailto:me@example.com',
    'javascript:alert(1)',
    'ssh://host/x',
    'vscode://file/x',
    'data:text/plain,x',
    'not a url',
    '',
    'https://user:fixture@example.com/',
    'file://user@host/etc/passwd',
    'file://host:22/etc/hosts',
    'file:///bad%ZZ',
    'file:///a%00b',
    'file:///a%0Ab',
    'file:////share/x',
    `https://example.com/${'a'.repeat(8200)}`,
    'https://example.com/\x07',
  ])
    assert.equal(terminalLinkTarget(uri), undefined, uri)
  assert.equal(publicWebUrl('https://example.com/'), 'https://example.com/')
  assert.equal(publicWebUrl('http://localhost/'), undefined)
  assert.equal(publicWebUrl('file:///x'), undefined)
})

test('activation dispatches each target to one action', () => {
  const calls: string[] = []
  const actions = {
    openWeb: (url: string) => calls.push(`web ${url}`),
    forwardWeb: (url: string) => calls.push(`forward ${url}`),
    openFile: (path: string) => calls.push(`file ${path}`),
  }
  assert.equal(activateTerminalLink('https://example.com/', actions), true)
  assert.equal(activateTerminalLink('http://localhost:3000/', actions), true)
  assert.equal(activateTerminalLink('file://host/tmp/a%20b.txt', actions), true)
  assert.equal(activateTerminalLink('ftp://example.com/', actions), false)
  assert.deepEqual(calls, [
    'web https://example.com/',
    'forward http://localhost:3000/',
    'file /tmp/a b.txt',
  ])
})

test('a file link matches only its exact verified scan item', () => {
  const scan: WindowContentScan = {
    id: 's',
    truncated: false,
    panes: [
      {
        id: 'p1',
        name: '',
        items: [
          { id: '1', kind: 'link', label: 'x', url: 'https://example.com/' },
          { id: '2', kind: 'file', label: 'u', path: null },
        ],
      },
      {
        id: 'p2',
        name: '',
        items: [
          { id: '3', kind: 'file', label: 'a', path: '/src/a.ts' },
          { id: '4', kind: 'file', label: 'b', path: '/src/b.ts:4' },
        ],
      },
    ],
  }
  assert.equal(scannedFile(scan, '/src/a.ts')?.id, '3')
  assert.equal(scannedFile(scan, '/src/a.ts:12:3'), undefined)
  assert.equal(scannedFile(scan, '/src/b.ts:4')?.id, '4')
  assert.equal(scannedFile(scan, '/src/a.tsx'), undefined)
  assert.equal(scannedFile(scan, '/other'), undefined)
})

test('loopback detection covers trailing-dot and IPv4-mapped loopback hosts', async () => {
  const { terminalLinkTarget } = await import('./terminal-links.ts')
  for (const url of [
    'http://localhost./',
    'http://[::ffff:127.0.0.1]:8080/',
    'http://[::ffff:7f00:1]/',
  ])
    assert.deepEqual(
      terminalLinkTarget(url),
      { kind: 'web', url: new URL(url).href, loopback: true },
      url,
    )
  assert.equal(
    terminalLinkTarget('http://[::ffff:8.8.8.8]/')?.kind === 'web' &&
      (terminalLinkTarget('http://[::ffff:8.8.8.8]/') as { loopback: boolean }).loopback,
    false,
  )
})
