/** Keep two essential 44 px controls; fold the primary action before reducing the reserved region. */
export function compactHeader(width: number, gap: number, position: 'left' | 'center' | 'right'): boolean {
  if (!Number.isFinite(width) || width <= 0) return true
  const reserved = Math.max(0, Math.min(gap, width - 176))
  return position === 'center' && reserved > 0 ? (width - reserved) / 2 < 132 : width - reserved < 220
}
