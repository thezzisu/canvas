import test from 'node:test'
import assert from 'node:assert/strict'
import { computed, ref } from 'vue'
import {
  mergeLiveResources,
  metadataAfterListing,
  newerListings,
  windowIsClosed,
  type LiveWindowMetadata,
} from './live-resources.ts'
import { canvasIndicators, windowVisualState } from './canvas-status.ts'
import { overviewResources } from '../canvas/overview.ts'
import type { WindowMetadata } from '../../../../shared/window-metadata.ts'
import type { SourceResource } from '../../api/types.ts'

const source = (): SourceResource => ({
  id: 'source',
  name: 'Source',
  status: 'online',
  readAt: 2,
  spaces: [
    {
      id: 'space',
      name: 'Space',
      windows: [
        {
          id: 'window',
          name: 'Tab',
          status: 'done',
          panes: [
            { id: 'pane', name: '1', status: 'done', active: true, terminalTitle: 'Old title' },
          ],
        },
      ],
    },
  ],
})
const metadata = (status: WindowMetadata['status']): WindowMetadata => ({
  id: 'window',
  name: 'Tab',
  status,
  panes: [{ id: 'pane', name: '1', active: true, status, terminalTitle: 'Live title' }],
})

test('closed presentation requires native removal or a successful source snapshot without that identity', () => {
  assert.equal(windowIsClosed(source(), 'window'), false)
  assert.equal(windowIsClosed(source(), 'missing'), true)
  assert.equal(windowIsClosed(undefined, 'window'), false)
  assert.equal(windowIsClosed({ ...source(), status: 'offline' }, 'missing'), false)
  assert.equal(windowIsClosed({ ...source(), error: 'Connection lost' }, 'missing'), false)
  assert.equal(
    windowIsClosed(undefined, 'window', null),
    true,
    'confirmed removal remains closed during a later outage',
  )
  assert.equal(
    windowIsClosed(source(), 'missing', metadata('idle')),
    false,
    'newer live metadata wins over a stale missing snapshot',
  )
  const moved = source()
  moved.spaces.push({ id: 'elsewhere', name: 'Elsewhere', windows: moved.spaces[0]!.windows })
  moved.spaces[0]!.windows = []
  assert.equal(
    windowIsClosed(moved, 'window'),
    false,
    'moving spaces does not close the native identity',
  )
  const replacement = source()
  replacement.spaces[0]!.windows[0]!.id = 'new-id'
  assert.equal(
    windowIsClosed(replacement, 'window'),
    true,
    'a same-name replacement does not adopt the closed reference',
  )
})

test('live metadata updates every resource consumer while another source holds an older poll', async () => {
  const polled = ref([source()]),
    live = ref(new Map<string, WindowMetadata>())
  const resources = computed(() => mergeLiveResources(polled.value, live.value))
  const stale = [source()]
  let finishSlowSource!: () => void
  const polling = Promise.all([
    Promise.resolve(stale),
    new Promise<void>((resolve) => {
      finishSlowSource = resolve
    }),
  ]).then(([snapshot]) => {
    polled.value = snapshot
  })
  live.value = new Map([['source/window', metadata('idle')]])
  const verify = () => {
    const current = resources.value[0]!,
      window = current.spaces[0]!.windows[0]!
    assert.equal(windowVisualState(current, window, true).status, 'idle')
    assert.equal(window.panes?.[0]?.terminalTitle, 'Live title')
    assert.equal(canvasIndicators([], resources.value).overview?.status, 'idle')
    assert.deepEqual(overviewResources(resources.value, { statuses: ['done'] }, 'native'), [])
  }
  verify()
  finishSlowSource()
  await polling
  verify()
  assert.equal(
    polled.value[0]!.spaces[0]!.windows[0]!.status,
    'done',
    'test did not preserve a stale poll',
  )
  live.value = new Map()
  assert.equal(
    resources.value[0]!.spaces[0]!.windows[0]!.status,
    'done',
    'disconnection did not release the live overlay',
  )
})

test('live metadata never resurrects removed windows or sources and preserves titles absent from endpoint snapshots', () => {
  const value = metadata('unknown')
  delete value.panes[0]!.terminalTitle
  const live = new Map([['source/window', value]])
  assert.equal(
    mergeLiveResources([source()], live)[0]!.spaces[0]!.windows[0]!.panes?.[0]?.terminalTitle,
    'Old title',
  )
  assert.deepEqual(mergeLiveResources([], live), [])
  const removed = source()
  removed.spaces[0]!.windows = []
  assert.deepEqual(mergeLiveResources([removed], live)[0]!.spaces[0]!.windows, [])
  const other = { ...source(), id: 'another-source' }
  assert.equal(mergeLiveResources([other], live)[0]!.spaces[0]!.windows[0]!.status, 'done')
})

test('a later listing can refresh fields not pushed by herdr while newer changes and offline sources stay live', () => {
  const old = metadata('done'),
    fresh = metadata('idle')
  const changed = new Map([
    ['source/window', fresh],
    ['offline/window', old],
  ])
  assert.equal(
    metadataAfterListing(changed, new Map([['source/window', 2]]), [
      { id: 'source', readAt: 1 },
    ]).get('source/window'),
    fresh,
    'a listing read earlier erased newer native metadata',
  )
  const after = metadataAfterListing(changed, new Map([['source/window', 2]]), [
    { id: 'source', readAt: 3 },
  ])
  assert.equal(after.has('source/window'), false)
  assert.equal(after.get('offline/window'), old)
  const refreshed = source()
  refreshed.spaces[0]!.windows[0]!.status = 'idle'
  refreshed.spaces[0]!.windows[0]!.panes![0]!.terminalTitle = 'New API title'
  assert.equal(
    mergeLiveResources([refreshed], after)[0]!.spaces[0]!.windows[0]!.panes?.[0]?.terminalTitle,
    'New API title',
  )
})

test('confirmed window removal wins over earlier and offline listings until a later online one', () => {
  const at = new Map([['source/window', 2]])
  const removed = new Map<string, LiveWindowMetadata>([['source/window', null]])
  const stale = metadataAfterListing(removed, at, [{ id: 'source', readAt: 1 }])
  assert.equal(stale.get('source/window'), null)
  assert.equal(
    windowIsClosed(source(), 'window', stale.get('source/window')),
    true,
    'a stale present snapshot cannot resume a window removed after it was read',
  )
  assert.deepEqual(
    mergeLiveResources([source()], stale)[0]!.spaces[0]!.windows,
    [],
    'an older listing resurrected the closed window',
  )
  const offline = { ...source(), status: 'offline', error: 'Connection lost' }
  const hidden = metadataAfterListing(removed, at, [])
  assert.deepEqual(
    mergeLiveResources([offline], hidden)[0]!.spaces[0]!.windows,
    [],
    'offline fallback resurrected the closed window',
  )
  assert.deepEqual(canvasIndicators([], mergeLiveResources([source()], stale)).overview, {
    count: 0,
    status: null,
  })
  const fresh = metadataAfterListing(removed, at, [{ id: 'source', readAt: 3 }])
  assert.equal(
    fresh.has('source/window'),
    false,
    'a new authoritative listing must be able to describe a replacement native window',
  )
  assert.equal(
    windowIsClosed(source(), 'window', fresh.get('source/window')),
    false,
    'only a poll begun after removal can confirm the identity is present again',
  )
  assert.equal(mergeLiveResources([source()], fresh)[0]!.spaces[0]!.windows.length, 1)
  assert.equal(
    mergeLiveResources([{ ...source(), id: 'unrelated' }], removed)[0]!.spaces[0]!.windows.length,
    1,
  )
})

test('of a push and a request that overtook each other, the later read wins', () => {
  const held = [source()]
  assert.deepEqual(newerListings(held, [{ ...source(), readAt: 1 }]), [])
  assert.equal(newerListings(held, [{ ...source(), readAt: 3 }]).length, 1)
  assert.equal(newerListings(held, [{ ...source(), id: 'other', readAt: 1 }]).length, 1)
})
