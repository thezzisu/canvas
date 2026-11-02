/** Fold optional actions before the 44 px controls crowd the title or cutout. */
export function compactHeader(width: number, gap: number, position: 'left' | 'center' | 'right', controls = 3): boolean {
  if (!Number.isFinite(width) || width <= 0) return true
  const reserved = Math.max(0, Math.min(gap, width - 176))
  return position === 'center' && reserved > 0 ? (width - reserved) / 2 < controls * 44 : width - reserved < (controls + 2) * 44
}
