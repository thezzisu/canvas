import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, type Source } from './state.ts'
import { CompletionReads } from './completion-reads.ts'
import type { WindowMetadata } from '../shared/window-metadata.ts'
import type { SourceResource } from './runtimes.ts'
const source: Source = { id: 'source', name: 'Source', transport: 'local' }
function completed(sequence = 3, bootId = 'boot'): WindowMetadata {
  return { id: 'window', name: 'Window', bootId, status: 'done', panes: [
    { id: 'left', name: 'Left', active: true, status: 'done', stateSequence: sequence, completion: { bootId, sequence } },
    { id: 'right', name: 'Right', active: false, status: 'done', stateSequence: 9, completion: { bootId, sequence: 9 } },
  ] }
}
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'canvas-completion-')), path = join(root, 'state.db')
  const store = new Store(path); store.put('source', source)
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }) })
  return { store, reads: new CompletionReads(store), path }
}

test('read watermarks are pane-specific, idempotent, shared, and reject old/future completions', t => {
  const { reads } = fixture(t), first = completed()
  assert.equal(reads.observe(source, first).panes[0]!.status, 'done', 'initial completion remains unread')
  assert(reads.acknowledge(source, 'window', 'left', first.panes[0]!.completion))
  const view = reads.project(source, first)
  assert.equal(view.panes[0]!.status, 'idle'); assert.equal(view.panes[1]!.status, 'done'); assert.equal(view.status, 'done')
  assert(!reads.acknowledge(source, 'window', 'left', first.panes[0]!.completion))
  const later = completed(5); reads.observe(source, later)
  assert.equal(reads.project(source, later).panes[0]!.status, 'done')
  assert(!reads.acknowledge(source, 'window', 'left', first.panes[0]!.completion))
  assert(!reads.acknowledge(source, 'window', 'left', { bootId: 'boot', sequence: 6 }))
  assert(!reads.acknowledge(source, 'other', 'left', later.panes[0]!.completion))
})

test('read state survives Canvas restart but not herdr reboot or source connection replacement', t => {
  const { store, reads, path } = fixture(t), window = completed()
  reads.observe(source, window); reads.acknowledge(source, 'window', 'left', window.panes[0]!.completion)
  const reopened = new Store(path), afterRestart = new CompletionReads(reopened)
  try {
    assert.notEqual(reopened.instanceId, store.instanceId)
    assert.equal(afterRestart.observe(source, window).panes[0]!.status, 'idle')
    assert.equal(afterRestart.observe(source, completed(3, 'new-boot')).panes[0]!.status, 'done')
    const replacement = { ...source, herdrSession: 'another' }; reopened.put('source', replacement)
    assert(!afterRestart.acknowledge(source, 'window', 'left', window.panes[0]!.completion))
    assert.equal(afterRestart.observe(replacement, window).panes[0]!.status, 'done')
  } finally { reopened.close() }
})

test('poll projection cannot revive read completion or overwrite a newer native transition', t => {
  const { reads } = fixture(t), window = completed()
  reads.observe(source, window); reads.acknowledge(source, 'window', 'left', window.panes[0]!.completion)
  const resource: SourceResource = { id: source.id, name: source.name, status: 'online', spaces: [{ id: 'space', name: 'Space', windows: [window] }] }
  assert.equal(reads.projectResources(source, resource).spaces[0]!.windows[0]!.panes[0]!.status, 'idle')
  const newer = structuredClone(resource); newer.spaces[0]!.windows[0]!.panes[0] = { id: 'left', name: 'Left', active: true, status: 'working', stateSequence: 4 }
  assert.equal(reads.projectResources(source, newer).spaces[0]!.windows[0]!.panes[0]!.status, 'working')
  const offline = { ...resource, status: 'offline' as const }; assert.equal(reads.projectResources(source, offline), offline)
  assert.equal(reads.project(source, window).panes[0]!.status, 'idle', 'transient offline does not clear reads')
})

test('confirmed pane/window/source removal prunes only its completion records; renaming preserves them', t => {
  const { store, reads } = fixture(t), window = completed()
  reads.observe(source, window); reads.acknowledge(source, 'window', 'left', window.panes[0]!.completion)
  reads.acknowledge(source, 'window', 'right', window.panes[1]!.completion)
  const renamed = { ...source, name: 'Renamed' }; store.put('source', renamed)
  assert.equal(reads.project(renamed, window).status, 'idle')
  reads.observe(renamed, { ...window, panes: window.panes.slice(1) })
  assert.deepEqual(store.get<{ read: Record<string, number> }>('completion-read', source.id)!.read, { right: 9 })
  reads.removeWindow(renamed, 'window')
  assert.deepEqual(store.get<{ read: Record<string, number> }>('completion-read', source.id)!.read, {})
  store.remove('source', source.id)
  assert.equal(store.get('completion-read', source.id), undefined)
})


test('native projection revisions are local to the intake owner; pane transitions never regress on handoff', t => {
  const { reads } = fixture(t), firstOwner = {}, nextOwner = {};
  reads.observeSnapshot(source, [completed(10)], { bootId: 'boot', revision: 100 }, firstOwner)
  reads.observeSnapshot(source, [completed(11)], { bootId: 'boot', revision: 2 }, nextOwner)
  assert.equal(reads.completion(source, 'left')?.completion.sequence, 11)
  reads.observeSnapshot(source, [completed(9)], { bootId: 'boot', revision: 3 }, nextOwner)
  assert.equal(reads.completion(source, 'left')?.completion.sequence, 11, 'pane sequence protects owner handoff from stale cache')
  reads.observeSnapshot(source, [completed(1, 'new-boot')], { bootId: 'new-boot', revision: 1 }, {})
  reads.observeSnapshot(source, [completed(99)], { bootId: 'boot', revision: 999 }, firstOwner)
  assert.equal(reads.completion(source, 'left')?.completion.bootId, 'new-boot', 'retired endpoint cannot revive an old herdr boot')
})


test('last endpoint disconnect retires live projection authority without deleting durable reads', t => {
  const { reads, store } = fixture(t), window = completed()
  reads.observe(source, window); reads.acknowledge(source, 'window', 'left', window.panes[0]!.completion)
  reads.disconnected(source.id)
  const resource: SourceResource = { id: source.id, name: source.name, status: 'online', spaces: [{ id: 'space', name: 'Space', windows: [window] }] }
  assert.equal(reads.projectResources(source, resource), resource)
  assert(store.get('completion-read', source.id))
  assert.equal(reads.observe(source, window).panes[0]!.status, 'idle', 'same boot restores its persisted reads')
  assert.equal(reads.observe(source, completed(3, 'replacement')).panes[0]!.status, 'done', 'new boot cannot reuse old read authority')
})


test('verified unread completions survive Canvas restart when an older herdr reports the same transition as Idle', t => {
  const { reads, path } = fixture(t), window = completed()
  reads.observe(source, window)
  reads.acknowledge(source, 'window', 'left', window.panes[0]!.completion)
  const opened = new Store(path), restored = new CompletionReads(opened)
  try {
    const idle = { ...window, status: 'idle' as const, panes: window.panes.map(({ completion, ...pane }) => ({ ...pane, status: 'idle' as const })) }
    const projected = restored.observe(source, idle)
    assert.equal(projected.panes[0]!.status, 'idle', 'read sibling stays read')
    assert.equal(projected.panes[1]!.status, 'done', 'verified unread result survives upstream seen projection')
    assert.deepEqual(projected.panes[1]!.completion, window.panes[1]!.completion)
    assert(restored.acknowledge(source, 'window', 'right', projected.panes[1]!.completion))
    const revision = opened.revision
    restored.observe(source, idle); restored.observe(source, idle)
    assert.equal(opened.revision, revision, 'unchanged snapshots do not rewrite durable completion evidence')
    const newWork = { ...idle, panes: idle.panes.map(pane => ({ ...pane, status: 'working' as const, stateSequence: pane.stateSequence! + 1 })) }
    assert(restored.observe(source, newWork).panes.every(pane => !pane.completion && pane.status === 'working'))
    const newIdle = { ...newWork, panes: newWork.panes.map(pane => ({ ...pane, status: 'idle' as const })) }
    assert(restored.observe(source, newIdle).panes.every(pane => !pane.completion && pane.status === 'idle'), 'a different idle transition is not inferred from old evidence')
  } finally { opened.close() }
})

test('initial idle without completion evidence is never guessed from its nonzero sequence', t => {
  const { store, reads } = fixture(t)
  const native = completed()
  const idle = { ...native, panes: native.panes.map(({ completion, ...pane }) => ({ ...pane, status: 'idle' as const })) }
  assert(reads.observe(source, idle).panes.every(pane => !pane.completion && pane.status === 'idle'))
  assert.equal(store.get('completion-read', source.id), undefined)
})

test('native read labels remain authoritative through reads, unread changes and resource polling', t => {
  const { store, reads } = fixture(t), nativeSource: Source = { ...source, runtime: 'core' };
  store.put('source', nativeSource);
  const unread: WindowMetadata = { ...completed(), readAuthority: 'native' };
  assert.equal(reads.observe(nativeSource, unread), unread);
  assert.equal(reads.completion(nativeSource, 'left')?.completion.sequence, 3);
  assert.equal(reads.acknowledge(nativeSource, 'window', 'left', unread.panes[0]!.completion), false);
  assert.equal(store.get('completion-read', source.id), undefined);
  const seen: WindowMetadata = { ...unread, status: 'idle', panes: unread.panes.map(pane => ({ ...pane, status: 'idle' })) };
  assert.equal(reads.observe(nativeSource, seen).status, 'idle');
  assert.equal(reads.project(nativeSource, unread).status, 'done', 'upstream mark unread is preserved');
  const resource: SourceResource = { id: source.id, name: source.name, status: 'online', spaces: [{ id: 'space', name: 'Space', windows: [unread] }] };
  assert.equal(reads.projectResources(nativeSource, resource), resource, 'fresh labels win over cached rendered views');
});
