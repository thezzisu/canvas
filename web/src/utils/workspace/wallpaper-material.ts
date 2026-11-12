/** Bake an opaque wallpaper tint once; terminal output never enters this image. */
export async function wallpaperMaterial(url: string): Promise<string> {
  const image = new Image()
  image.src = url
  await image.decode()
  const sample = document.createElement('canvas')
  sample.width = sample.height = 8
  const sampling = sample.getContext('2d')
  if (!sampling) return ''
  sampling.drawImage(image, 0, 0, 8, 8)

  const surface = document.createElement('canvas')
  surface.width = surface.height = 128
  const context = surface.getContext('2d')
  if (!context) return ''
  context.fillStyle = '#1b1f26'
  context.fillRect(0, 0, 128, 128)
  context.imageSmoothingQuality = 'high'
  context.globalAlpha = 0.22
  context.filter = 'blur(16px)'
  context.drawImage(sample, -32, -32, 192, 192)
  return surface.toDataURL('image/png')
}
