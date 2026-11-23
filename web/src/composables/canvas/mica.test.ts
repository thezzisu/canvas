import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coverBackground, materialBox } from './mica'
import { MATERIAL_MARGIN } from '../../utils/workspace/wallpaper-material'

const stage = { left: 200, top: 100, width: 1000, height: 600 }

test('the material lies over the wallpaper as cover places it, and over its margin', () => {
  // A 2:1 wallpaper is as tall as the stage and centred across it.
  const box = materialBox(stage, { width: 2000, height: 1000 })
  const width = 1200,
    height = 600
  assert.deepEqual(box, {
    left: 200 - 100 - width * MATERIAL_MARGIN,
    top: 100 - height * MATERIAL_MARGIN,
    width: width * (1 + 2 * MATERIAL_MARGIN),
    height: height * (1 + 2 * MATERIAL_MARGIN),
  })
  // A tall one is as wide as the stage.
  const tall = materialBox(stage, { width: 500, height: 1000 })
  assert.equal(tall.width, 1000 * (1 + 2 * MATERIAL_MARGIN))
  assert.equal(tall.top, 100 + (600 - 2000) / 2 - 2000 * MATERIAL_MARGIN)
})

test('a cover shows the part of the material behind it, whatever its scale', () => {
  const box = materialBox(stage, { width: 1000, height: 600 })
  // A cover on screen at the stage's own scale.
  assert.deepEqual(coverBackground(box, { left: 450, top: 250, width: 300, height: 200 }, 1), {
    position: `${box.left - 450}px ${box.top - 250}px`,
    size: `${box.width}px ${box.height}px`,
  })
  // The same place in a card zoomed out to half: its pixels are twice as many per screen pixel.
  assert.deepEqual(coverBackground(box, { left: 450, top: 250, width: 150, height: 100 }, 0.5), {
    position: `${(box.left - 450) * 2}px ${(box.top - 250) * 2}px`,
    size: `${box.width * 2}px ${box.height * 2}px`,
  })
  // Moving the cover moves what it shows the other way, by as much on screen.
  const moved = coverBackground(box, { left: 550, top: 250, width: 300, height: 200 }, 1)
  assert.equal(moved.position, `${box.left - 550}px ${box.top - 250}px`)
})

test('an image of no size lies over the stage', () => {
  const box = materialBox(stage, { width: 0, height: 0 })
  assert.equal(box.width, 1000 * (1 + 2 * MATERIAL_MARGIN))
  assert.equal(box.left, 200 - 1000 * MATERIAL_MARGIN)
})
