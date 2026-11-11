const key = 'canvas:composer-height'
const DEFAULT = 0.4,
  FULL = 0.9,
  MIN_PX = 96

/** The composer covers this fraction of the terminal, remembered per device. */
export function readStoredHeight(): number {
  try {
    const value = Number(localStorage.getItem(key))
    if (value > 0 && value <= 1) return value
  } catch {
    /* Storage can be unavailable. */
  }
  return DEFAULT
}
export function storeHeight(value: number) {
  try {
    localStorage.setItem(key, String(value))
  } catch {
    /* Storage can be unavailable. */
  }
}
/** Near the bottom it snaps to full coverage; dragged far up it collapses. */
export function composerHeightBounds(
  fraction: number,
  hostHeight: number,
): { value: number; collapse: boolean } {
  const minimum = Math.min(1, MIN_PX / Math.max(1, hostHeight))
  if (fraction < Math.min(minimum * 0.6, 0.3)) return { value: minimum, collapse: true }
  if (minimum >= FULL) return { value: 1, collapse: false }
  if (fraction >= FULL) return { value: 1, collapse: false }
  return { value: Math.min(FULL, Math.max(minimum, fraction)), collapse: false }
}
