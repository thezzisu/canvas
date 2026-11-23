/** A wallpaper's material: the opaque tinted image, and the size of the wallpaper it was made of. */
export interface WallpaperMaterial {
  url: string
  width: number
  height: number
}
/**
 * The material reaches this far beyond the wallpaper on each side, as a share of the wallpaper's
 * size, so a card that leaves the canvas, or a maximized one over the sidebar, stays covered.
 */
export const MATERIAL_MARGIN = 0.25
/** The wallpaper is sampled as 8×8 cells, and each cell is this many pixels of the material. */
const CELL = 16
/** As soft relative to a cell as the first material, which drew 24px cells with a 16px blur. */
const BLUR = (CELL * 2) / 3
/** Cells repeated beyond the edge, so the blur fades outside the material and not into it. */
const PAD = 4

/** Bake an opaque wallpaper tint once; terminal output never enters this image. */
export async function wallpaperMaterial(url: string): Promise<WallpaperMaterial> {
  const image = new Image()
  image.src = url
  await image.decode()
  const sample = document.createElement('canvas')
  sample.width = sample.height = 8
  const sampling = sample.getContext('2d')
  if (!sampling) throw new Error('No canvas')
  sampling.drawImage(image, 0, 0, 8, 8)

  // The sample with its edge cells repeated outward.
  const size = 8 + 2 * PAD
  const padded = document.createElement('canvas')
  padded.width = padded.height = size
  const padding = padded.getContext('2d')
  if (!padding) throw new Error('No canvas')
  padding.imageSmoothingEnabled = false
  const spans = [
    [0, 1, 0, PAD],
    [0, 8, PAD, 8],
    [7, 1, PAD + 8, PAD],
  ] as const
  for (const [sx, sw, dx, dw] of spans)
    for (const [sy, sh, dy, dh] of spans) padding.drawImage(sample, sx, sy, sw, sh, dx, dy, dw, dh)

  // The wallpaper and its margin, in that order of cells: the wallpaper spans the middle.
  const margin = 8 * MATERIAL_MARGIN
  const surface = document.createElement('canvas')
  surface.width = surface.height = (8 + 2 * margin) * CELL
  const context = surface.getContext('2d')
  if (!context) throw new Error('No canvas')
  context.fillStyle = '#1b1f26'
  context.fillRect(0, 0, surface.width, surface.height)
  context.imageSmoothingQuality = 'high'
  context.globalAlpha = 0.22
  context.filter = `blur(${BLUR}px)`
  context.drawImage(padded, (margin - PAD) * CELL, (margin - PAD) * CELL, size * CELL, size * CELL)
  return {
    url: surface.toDataURL('image/png'),
    width: image.naturalWidth,
    height: image.naturalHeight,
  }
}
