import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Store, type Source } from './state.ts'

test('window read times are ordered, survive restarts and leave with their window or connection', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'canvas-window-reads-')),
    path = join(dir, 'state.db')
  let store = new Store(path)
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const source = store.put<Source>('source', { id: randomUUID(), name: 'A', transport: 'local' })
  const other = store.put<Source>('source', { id: randomUUID(), name: 'B', transport: 'local' })
  const key = (connection: Source, windowId: string) => `${connection.id}/${windowId}`
  const revision = store.revision
  store.markWindowRead(source, 'one')
  store.markWindowRead(source, 'two')
  store.markWindowRead(other, 'one')
  const reads = store.snapshot().windowReads
  assert.equal(store.revision, revision + 3, 'every read start publishes shared state')
  assert(
    reads[key(source, 'one')]! < reads[key(source, 'two')]! &&
      reads[key(source, 'two')]! < reads[key(other, 'one')]!,
    'reads keep their start order',
  )
  store.markWindowRead({ ...source, herdrSocket: '/replaced/herdr.sock' }, 'one')
  store.markWindowRead({ ...source, id: randomUUID() }, 'one')
  assert.deepEqual(
    store.snapshot().windowReads,
    reads,
    'stale or removed connections cannot record reads',
  )

  store.close()
  store = new Store(path)
  assert.deepEqual(store.snapshot().windowReads, reads)
  store.removeWindowReferences(source, ['one'])
  store.markWindowRead(source, 'one')
  assert.deepEqual(
    store.snapshot().windowReads,
    {
      [key(source, 'two')]: reads[key(source, 'two')],
      [key(other, 'one')]: reads[key(other, 'one')],
    },
    'closing through Canvas removes the read and late focus reports cannot recreate it',
  )
  store.remove('source', source.id)
  assert.deepEqual(store.snapshot().windowReads, { [key(other, 'one')]: reads[key(other, 'one')] })
  store.markWindowRead(other, 'one')
  assert(
    store.snapshot().windowReads[key(other, 'one')]! > reads[key(other, 'one')]!,
    'a new read start moves the window forward',
  )
})
