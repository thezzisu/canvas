import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  agentIndicator,
  canvasIndicators,
  connectionIndicator,
  windowVisualState,
} from './canvas-status.ts'
import type { Canvas, CanvasNode, SourceResource } from '../api/types.ts'

const resources: SourceResource[] = [
  {
    id: 'a',
    name: 'A',
    status: 'online',
    spaces: [
      {
        id: 'space',
        name: 'Space',
        windows: [
          { id: 'working', name: 'Working', status: 'working' },
          { id: 'done', name: 'Done', status: 'done' },
          { id: 'attention', name: 'Attention', status: 'attention' },
        ],
      },
    ],
  },
]
const terminal = (windowId: string, sourceId = 'a'): CanvasNode => ({
  id: windowId,
  type: 'terminal',
  sourceId,
  spaceId: 'old-space',
  windowId,
  x: 0,
  y: 0,
  width: 400,
  height: 300,
})
const canvas = (id: string, nodes: CanvasNode[]): Canvas => ({ id, name: id, nodes })

test('canvas indicators aggregate all linked windows regardless of spaces or duplicate cards', () => {
  const result = canvasIndicators(
    [
      canvas('done', [terminal('working'), terminal('done'), terminal('done')]),
      canvas('attention', [terminal('done'), terminal('attention')]),
    ],
    resources,
  )
  assert.deepEqual(result.overview, { count: 3, status: 'attention' })
  assert.deepEqual(result.done, { count: 3, status: 'done' })
  assert.deepEqual(result.attention, { count: 2, status: 'attention' })
})

test('empty canvases, nonterminal cards and unreported windows retain distinct meanings', () => {
  const note: CanvasNode = {
    id: 'n',
    type: 'note',
    title: 'Note',
    content: '',
    color: 'blue',
    x: 0,
    y: 0,
    width: 300,
    height: 200,
  }
  const result = canvasIndicators(
    [canvas('empty', []), canvas('notes', [note]), canvas('missing', [note, terminal('closed')])],
    [],
  )
  assert.deepEqual(result.overview, { count: 0, status: null })
  assert.deepEqual(result.empty, { count: 0, status: null })
  assert.deepEqual(result.notes, { count: 1, status: null })
  assert.deepEqual(result.missing, { count: 2, status: 'unknown' })
})

test('background or refreshing tabs keep their last native status without adding animation state', () => {
  const source = resources[0]!,
    window = source.spaces[0]!.windows[2]!
  assert.deepEqual(windowVisualState(source, window, false), { status: 'attention', fresh: false })
  assert.deepEqual(canvasIndicators([canvas('a', [terminal('attention')])], [source]).a, {
    count: 1,
    status: 'attention',
  })
  for (const fresh of [true, false, true, false, true]) {
    assert.equal(
      windowVisualState(source, { ...window, status: 'working' }, fresh).status,
      'working',
    )
  }
  assert.equal(windowVisualState(source, { ...window, status: 'done' }, true).status, 'done')
})

test('retained offline snapshots cannot announce attention', () => {
  const source = resources[0]!,
    window = source.spaces[0]!.windows[2]!
  for (const [entry, fresh] of [
    [{ ...source, status: 'offline' }, true],
    [{ ...source, error: 'disconnected' }, true],
  ] as const) {
    assert.deepEqual(windowVisualState(entry, window, fresh), { status: 'unknown', fresh: false })
  }
  assert.deepEqual(windowVisualState(source, undefined, true), { status: 'unknown', fresh: false })
  assert.deepEqual(windowVisualState(undefined, window, true), { status: 'unknown', fresh: false })
  assert.deepEqual(windowVisualState(source, { ...window, status: 'error' }, true), {
    status: 'unknown',
    fresh: true,
  })
})

test('an offline source cannot override live work in another source or leak status by window id', () => {
  const online = {
    ...resources[0]!,
    id: 'b',
    spaces: [
      {
        id: 's',
        name: 'S',
        windows: [{ id: 'attention', name: 'Busy', status: 'working' as const }],
      },
    ],
  }
  const mixed = [{ ...resources[0]!, status: 'offline', error: 'unavailable' }, online]
  const result = canvasIndicators(
    [canvas('both', [terminal('attention'), terminal('attention', 'b')])],
    mixed,
  )
  assert.deepEqual(result.both, { count: 2, status: 'working' })
  assert.equal(result.overview!.status, 'working')
})

test('online connections count every window across spaces; unavailable ones keep only their reason', () => {
  const source: SourceResource = {
    ...resources[0]!,
    spaces: [
      ...resources[0]!.spaces,
      { id: 'other', name: 'Other', windows: [{ id: 'idle', name: 'Idle', status: 'idle' }] },
    ],
  }
  assert.deepEqual(connectionIndicator(source, 'Connecting'), {
    indicator: { count: 4, status: 'attention' },
  })
  assert.deepEqual(
    connectionIndicator(
      { ...source, spaces: [{ id: 'empty', name: 'Empty', windows: [] }] },
      'Connecting',
    ),
    { indicator: { count: 0, status: null } },
  )
  assert.deepEqual(
    connectionIndicator({ ...source, status: 'offline', error: 'Socket missing' }, 'Connecting'),
    { unavailable: 'Socket missing' },
  )
  assert.deepEqual(
    connectionIndicator({ ...source, error: 'Discovery failed' }, 'Connecting'),
    { unavailable: 'Discovery failed' },
    'retained live windows of a failing connection are not counted',
  )
  assert.deepEqual(connectionIndicator({ ...source, status: 'offline' }, 'Connecting'), {
    unavailable: 'Connecting',
  })
  assert.deepEqual(
    connectionIndicator(undefined, 'Connecting'),
    { unavailable: 'Connecting' },
    'an undiscovered connection is still connecting',
  )
})

test('agent indicators count agents and report their highest priority; no agents show nothing', () => {
  assert.equal(agentIndicator([]), undefined)
  assert.deepEqual(
    agentIndicator([{ status: 'idle' }, { status: 'done' }, { status: 'working' }]),
    { count: 3, status: 'done' },
  )
})
