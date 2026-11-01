import test from 'node:test'
import assert from 'node:assert/strict'
import { Writer, FrameReader, decodeServerMessage, encodeClientMessage, MAX_FRAME_BYTES } from './wire.ts'

function framed(payload: Buffer) { const header = Buffer.alloc(4); header.writeUInt32LE(payload.length); return Buffer.concat([header, payload]) }

test('herdr bincode standard encoding matches frozen tags, variable integers and UTF-8 characters', () => {
  assert.deepEqual(new Writer().uint(250).uint(251).uint(65536).uint(0x100000000n).finish(), Buffer.from('fafbfb00fc00000100fd0000000001000000', 'hex'))
  assert.deepEqual(encodeClientMessage('Detach'), Buffer.from('0100000004', 'hex'))
  assert.deepEqual(encodeClientMessage({ ClientShellFocus: { focused: true } }), Buffer.from('020000001201', 'hex'))
  const frame = encodeClientMessage({ ClientShellPaneInput: { pane_id: 'p', events: [{ Key: {
    code: { Char: '中' }, modifiers: 0, kind: 'Press', repeat_count: 1, shifted_codepoint: null,
    generated_text: null, tracks_release: false, physical_key_id: null, windows_record: null,
  } }] } })
  assert.deepEqual(frame.subarray(4), Buffer.from([13, 1, 112, 1, 0, 15, 0xe4, 0xb8, 0xad, 0, 0, 1, 0, 0, 0, 0, 0]))
})

test('herdr streaming reader preserves arbitrary frame boundaries and complete message order', () => {
  const clipboard = framed(new Writer().uint(5).string('aGVsbG8=').finish())
  const control = framed(new Writer().uint(20).string('endpoint.health.pong.v1').string('{}').finish())
  const bytes = Buffer.concat([clipboard, control])
  for (const chunkSize of [1, 2, 3, 4, 9, bytes.length]) {
    const reader = new FrameReader(), messages = []
    for (let offset = 0; offset < bytes.length; offset += chunkSize) messages.push(...reader.feed(bytes.subarray(offset, offset + chunkSize)))
    assert.deepEqual(messages, [{ type: 'clipboard', data: 'aGVsbG8=' }, { type: 'control', kind: 'endpoint.health.pong.v1', data: '{}' }])
    reader.end()
  }
})

test('semantic notifications decode the frozen generation-one fields without treating presentation hints as commands', () => {
  const bytes = Buffer.from([14, 1, 4, 68, 111, 110, 101, 1, 5, 114, 101, 97, 100, 121,
    1, 0, 1, 2, 112, 105, 1, 1, 115, 1, 1, 116, 1, 1, 112, 1, 3])
  assert.deepEqual(decodeServerMessage(bytes), { type: 'notification', notification: {
    kind: 'done', title: 'Done', body: 'ready', agent: 'pi', spaceId: 's', windowId: 't', paneId: 'p',
  } })
  assert.deepEqual(decodeServerMessage(Buffer.from([14, 3, 4, 73, 110, 102, 111, 0, 0, 0, 0, 0, 0, 0])),
    { type: 'notification', notification: { kind: 'custom', title: 'Info' } })
})

test('unsupported optional notification frames never corrupt the following core message', () => {
  const notices = [
    Buffer.from([14, 4]), // Unknown semantic kind.
    Buffer.from([14, 0, 4, 65]), // Incomplete field within a complete outer frame.
    Buffer.from([14, 3, 1, 255, 0, 0, 0, 0, 0, 0, 0]), // Invalid UTF-8.
    Buffer.from([14, 3, 1, 65, 0, 0, 0, 0, 0, 0, 0, 99]), // Future trailing field.
  ]
  const core = new Writer().uint(20).string('shell.snapshot.v1').string('{"revision":7}').finish()
  const bytes = Buffer.concat([...notices, core].map(framed))
  for (const chunkSize of [1, 3, bytes.length]) {
    const reader = new FrameReader(), messages = []
    for (let offset = 0; offset < bytes.length; offset += chunkSize) messages.push(...reader.feed(bytes.subarray(offset, offset + chunkSize)))
    reader.end()
    assert.deepEqual(messages, [...notices.map(() => ({ type: 'ignored' })),
      { type: 'control', kind: 'shell.snapshot.v1', data: '{"revision":7}' }])
  }
})

test('herdr framing rejects oversized, truncated and structurally invalid peer messages', () => {
  const oversized = Buffer.alloc(4); oversized.writeUInt32LE(MAX_FRAME_BYTES + 1)
  assert.throws(() => new FrameReader().feed(oversized), /length/)
  const partial = new FrameReader(); partial.feed(Buffer.from([2, 0])); assert.throws(() => partial.end(), /Truncated/)
  assert.throws(() => decodeServerMessage(Buffer.from([8, 2, 0])), /boolean/)
  assert.throws(() => decodeServerMessage(Buffer.from([5, 2, 65])), /Truncated/)
  assert.throws(() => decodeServerMessage(Buffer.from([5, 1, 255])), /encoded data/)
  assert.throws(() => decodeServerMessage(Buffer.from([9, 1, 0])), /Trailing/)
  assert.throws(() => decodeServerMessage(Buffer.from([13, 0, 1, 1, 253, 255, 255, 255, 255, 255, 255, 255, 255])), /bound/)
})
