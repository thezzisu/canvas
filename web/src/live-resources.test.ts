import test from 'node:test'
import assert from 'node:assert/strict'
import { computed, ref } from 'vue'
import { mergeLiveResources, metadataAfterPoll, type LiveWindowMetadata } from './live-resources.ts'
import { canvasIndicators, windowVisualState } from './canvas-status.ts'
import { overviewResources } from './overview.ts'
import type { WindowMetadata } from '../../shared/window-metadata.ts'
import type { SourceResource } from './types.ts'

const source = (): SourceResource => ({ id: 'source', name: 'Source', status: 'online', spaces: [{ id: 'space', name: 'Space', windows: [
  { id: 'window', name: 'Tab', status: 'done', panes: [{ id: 'pane', name: '1', status: 'done', active: true, terminalTitle: 'Old title' }] },
] }] })
const metadata = (status: WindowMetadata['status']): WindowMetadata => ({ id: 'window', name: 'Tab', status,
  panes: [{ id: 'pane', name: '1', active: true, status, terminalTitle: 'Live title' }] })

test('live metadata updates every resource consumer while another source holds an older poll', async () => {
  const polled = ref([source()]), live = ref(new Map<string, WindowMetadata>())
  const resources = computed(() => mergeLiveResources(polled.value, live.value))
  const stale = [source()]
  let finishSlowSource!: () => void
  const polling = Promise.all([Promise.resolve(stale), new Promise<void>(resolve => { finishSlowSource = resolve })])
    .then(([snapshot]) => { polled.value = snapshot })
  live.value = new Map([['source/window', metadata('idle')]])
  const verify = () => {
    const current = resources.value[0]!, window = current.spaces[0]!.windows[0]!
    assert.equal(windowVisualState(current, window, true).status, 'idle')
    assert.equal(window.panes?.[0]?.terminalTitle, 'Live title')
    assert.equal(canvasIndicators([], resources.value).overview?.status, 'idle')
    assert.deepEqual(overviewResources(resources.value, ['done'], 'native'), [])
  }
  verify()
  finishSlowSource(); await polling
  verify()
  assert.equal(polled.value[0]!.spaces[0]!.windows[0]!.status, 'done', 'test did not preserve a stale poll')
  live.value = new Map()
  assert.equal(resources.value[0]!.spaces[0]!.windows[0]!.status, 'done', 'disconnection did not release the live overlay')
})

test('live metadata never resurrects removed windows or sources and preserves titles absent from endpoint snapshots', () => {
  const value = metadata('unknown')
  delete value.panes[0]!.terminalTitle
  const live = new Map([['source/window', value]])
  assert.equal(mergeLiveResources([source()], live)[0]!.spaces[0]!.windows[0]!.panes?.[0]?.terminalTitle, 'Old title')
  assert.deepEqual(mergeLiveResources([], live), [])
  const removed = source(); removed.spaces[0]!.windows = []
  assert.deepEqual(mergeLiveResources([removed], live)[0]!.spaces[0]!.windows, [])
  const other = { ...source(), id: 'another-source' }
  assert.equal(mergeLiveResources([other], live)[0]!.spaces[0]!.windows[0]!.status, 'done')
})

test('a newer successful poll can refresh fields not pushed by herdr while in-flight changes and offline sources stay live', () => {
  const old = metadata('done'), fresh = metadata('idle')
  const started = new Map([['source/window', old], ['offline/window', old]])
  const changed = new Map([['source/window', fresh], ['offline/window', old]])
  assert.equal(metadataAfterPoll(changed, started, ['source']).get('source/window'), fresh, 'a slow old poll erased newer native metadata')
  const after = metadataAfterPoll(changed, changed, ['source'])
  assert.equal(after.has('source/window'), false)
  assert.equal(after.get('offline/window'), old)
  const refreshed = source(); refreshed.spaces[0]!.windows[0]!.status = 'idle'
  refreshed.spaces[0]!.windows[0]!.panes![0]!.terminalTitle = 'New API title'
  assert.equal(mergeLiveResources([refreshed], after)[0]!.spaces[0]!.windows[0]!.panes?.[0]?.terminalTitle, 'New API title')
})

test('confirmed window removal wins over in-flight and offline polls until a newer online snapshot', () => {
  const started = new Map<string, LiveWindowMetadata>([['source/window', metadata('done')]])
  const removed = new Map<string, LiveWindowMetadata>([['source/window', null]])
  const stale = metadataAfterPoll(removed, started, ['source'])
  assert.equal(stale.get('source/window'), null)
  assert.deepEqual(mergeLiveResources([source()], stale)[0]!.spaces[0]!.windows, [], 'an older poll resurrected the closed window')
  const offline = { ...source(), status: 'offline', error: 'Connection lost' }
  const hidden = metadataAfterPoll(removed, removed, [])
  assert.deepEqual(mergeLiveResources([offline], hidden)[0]!.spaces[0]!.windows, [], 'offline fallback resurrected the closed window')
  assert.deepEqual(canvasIndicators([], mergeLiveResources([source()], stale)).overview, { count: 0, status: null })
  const fresh = metadataAfterPoll(removed, removed, ['source'])
  assert.equal(fresh.has('source/window'), false, 'a new authoritative poll must be able to describe a replacement native window')
  assert.equal(mergeLiveResources([source()], fresh)[0]!.spaces[0]!.windows.length, 1)
  assert.equal(mergeLiveResources([{ ...source(), id: 'unrelated' }], removed)[0]!.spaces[0]!.windows.length, 1)
});
