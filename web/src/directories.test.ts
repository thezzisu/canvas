import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clearDirectories,
  directoryRequest,
  dismissDirectory,
  receiveDirectory,
} from './directories.ts'

test('structured directory delivery builds its browser link and acknowledges receipt once per delivery', (t) => {
  clearDirectories()
  t.after(clearDirectories)
  const replies: unknown[] = [],
    socket = {
      readyState: WebSocket.OPEN,
      send(value: string) {
        replies.push(JSON.parse(value))
      },
    } as WebSocket
  const message = {
    type: 'open-directory',
    id: 'request-one',
    path: '/project',
    authority: { hostName: 'host', user: 'dev' },
  }
  assert.equal(receiveDirectory(socket, message), true)
  assert.equal(directoryRequest.value?.path, '/project')
  assert.match(
    directoryRequest.value!.uri,
    /^vscode:\/\/vscode-remote\/ssh-remote\+[a-f\d]+\/project$/,
  )
  assert.deepEqual(replies, [{ type: 'directory-received', id: 'request-one' }])
  receiveDirectory(socket, message)
  dismissDirectory()
  assert.equal(
    directoryRequest.value,
    undefined,
    'Duplicate delivery does not queue another dialog',
  )
  assert.equal(replies.length, 2, 'A repeated delivery still receives its acknowledgement')
})

test('malformed directory targets neither appear nor acknowledge successful delivery', (t) => {
  clearDirectories()
  t.after(clearDirectories)
  const socket = {
    readyState: WebSocket.OPEN,
    send() {
      assert.fail('Invalid directory was acknowledged')
    },
  } as unknown as WebSocket
  for (const message of [
    { type: 'open-directory', id: 'bad', path: '../relative', authority: { hostName: 'host' } },
    { type: 'open-directory', id: 'bad', path: '/project', authority: { hostName: 'host/other' } },
    {
      type: 'open-directory',
      id: 'bad',
      path: '/project',
      uri: 'vscode://vscode-remote/ssh-remote+666f6f/project',
    },
  ])
    assert.equal(receiveDirectory(socket, message), true)
  assert.equal(directoryRequest.value, undefined)
  assert.equal(receiveDirectory(socket, { type: 'other' }), false)
})
