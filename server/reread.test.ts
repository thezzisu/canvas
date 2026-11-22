import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { Reread } from './reread.ts'

function fixture() {
  const start = performance.now(),
    reads: number[] = []
  const reread = new Reread(
    async () => void reads.push(performance.now() - start),
    () => {},
  )
  return { reads, reread }
}

test('a change is read soon, and changes that keep coming at most once a second', async (t) => {
  const { reads, reread } = fixture()
  t.after(() => reread[Symbol.dispose]())
  reread.schedule()
  await sleep(180)
  assert.equal(reads.length, 1, 'a lone change is read after the burst it may start')
  // An agent's spinner retitles its pane ten times a second.
  const spinner = setInterval(() => reread.schedule(), 100)
  t.after(() => clearInterval(spinner))
  await sleep(650)
  assert.equal(reads.length, 1, 'not again within a second of the last read')
  await sleep(500)
  assert.equal(reads.length, 2)
  assert(reads[1]! - reads[0]! >= 990, `${reads}`)
})

test('a read asked for now does not wait for the spacing', async (t) => {
  const { reads, reread } = fixture()
  t.after(() => reread[Symbol.dispose]())
  await reread.now()
  await reread.now()
  assert.equal(reads.length, 2)
})
