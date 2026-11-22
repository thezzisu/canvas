import test from 'node:test'
import assert from 'node:assert/strict'
import { PaneTitles, paneTitle, type PaneRecord } from './pane-titles.ts'

test('titles are shown as published: only control characters go, at most 1024 characters', () => {
  assert.equal(paneTitle(' \x1b⠋ Working\x07 '), '⠋ Working')
  assert.equal(paneTitle('● ⠙ canvas'), '● ⠙ canvas')
  assert.equal(paneTitle('中'.repeat(2000)).length, 1024)
  assert.equal(paneTitle(undefined), '')
})

test('the newer pane revision wins, whichever source it came from', () => {
  const titles = new PaneTitles(),
    changes: string[][] = []
  titles.changes.subscribe((paneIds) => changes.push([...paneIds]))
  titles.update({ pane_id: 'a', revision: 5, terminal_title_stripped: 'event' })
  // A snapshot read before that event arrives after it.
  titles.replace([
    { pane_id: 'a', revision: 4, terminal_title_stripped: 'older' },
    { pane_id: 'b', revision: 1, terminal_title_stripped: 'shell' },
  ])
  assert.equal(titles.title('a'), 'event')
  assert.equal(titles.title('b'), 'shell')
  titles.update({ pane_id: 'a', revision: 6, terminal_title_stripped: 'event' })
  assert.deepEqual(changes, [['a'], ['b']], 'an unchanged title is not a change')
  titles.replace([{ pane_id: 'b', revision: 2, terminal_title_stripped: '' }])
  assert.equal(titles.title('a'), undefined, 'a pane the server no longer lists is gone')
  assert.equal(titles.title('b'), '')
  titles.update({ pane_id: 'c', terminal_title_stripped: 'no revision' } as PaneRecord)
  assert.equal(titles.title('c'), undefined)
  titles.clear()
  assert.equal(titles.title('b'), undefined)
  assert.deepEqual(changes.at(-1), ['b'])
})
