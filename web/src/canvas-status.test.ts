import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canvasIndicators, windowVisualState } from './canvas-status.ts'
import type { Canvas, CanvasNode, SourceResource } from './types.ts'

const resources: SourceResource[] = [{ id: 'a', name: 'A', status: 'online', spaces: [
  { id: 'space', name: 'Space', windows: [{ id: 'working', name: 'Working', status: 'working' }, { id: 'done', name: 'Done', status: 'done' }, { id: 'attention', name: 'Attention', status: 'attention' }] },
] }]
const terminal = (windowId: string, sourceId = 'a'): CanvasNode => ({ id: windowId, type: 'terminal', sourceId, spaceId: 'old-space', windowId, x: 0, y: 0, width: 400, height: 300 })
const canvas = (id: string, nodes: CanvasNode[]): Canvas => ({ id, name: id, nodes })

test('canvas indicators aggregate all linked windows regardless of spaces or duplicate cards', () => {
  const result = canvasIndicators([
    canvas('done', [terminal('working'), terminal('done'), terminal('done')]),
    canvas('attention', [terminal('done'), terminal('attention')]),
  ], resources, true)
  assert.deepEqual(result.overview, { count: 3, status: 'attention', pulse: true })
  assert.deepEqual(result.done, { count: 3, status: 'done', pulse: true })
  assert.deepEqual(result.attention, { count: 2, status: 'attention', pulse: true })
})

test('empty canvases, nonterminal cards and unreported windows retain distinct meanings', () => {
  const note: CanvasNode = { id: 'n', type: 'note', title: 'Note', content: '', color: 'blue', minimized: false, x: 0, y: 0, width: 300, height: 200 }
  const result = canvasIndicators([canvas('empty', []), canvas('notes', [note]), canvas('missing', [note, terminal('closed')])], [], true)
  assert.deepEqual(result.overview, { count: 0, status: null, pulse: false })
  assert.deepEqual(result.empty, { count: 0, status: null, pulse: false })
  assert.deepEqual(result.notes, { count: 1, status: null, pulse: false })
  assert.deepEqual(result.missing, { count: 2, status: 'unknown', pulse: false })
})

test('retained offline snapshots and a failed refresh cannot announce attention', () => {
  const source = resources[0]!, window = source.spaces[0]!.windows[2]!
  for (const [entry, fresh] of [[source, false], [{ ...source, status: 'offline' }, true], [{ ...source, error: 'disconnected' }, true]] as const) {
    assert.deepEqual(windowVisualState(entry, window, fresh), { status: 'unknown', fresh: false, pulse: false })
    assert.equal(canvasIndicators([canvas('a', [terminal('attention')])], [entry], fresh).a!.pulse, false)
  }
  assert.deepEqual(windowVisualState(source, undefined, true), { status: 'unknown', fresh: false, pulse: false })
  assert.deepEqual(windowVisualState(undefined, window, true), { status: 'unknown', fresh: false, pulse: false })
  assert.deepEqual(windowVisualState(source, { ...window, status: 'error' }, true), { status: 'unknown', fresh: true, pulse: false })
})

test('an offline source cannot override live work in another source or leak status by window id', () => {
  const online = { ...resources[0]!, id: 'b', spaces: [{ id: 's', name: 'S', windows: [{ id: 'attention', name: 'Busy', status: 'working' as const }] }] }
  const mixed = [ { ...resources[0]!, status: 'offline', error: 'unavailable' }, online ]
  const result = canvasIndicators([canvas('both', [terminal('attention'), terminal('attention', 'b')])], mixed, true)
  assert.deepEqual(result.both, { count: 2, status: 'working', pulse: false })
  assert.equal(result.overview!.status, 'working')
})
