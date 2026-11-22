import type { WindowProgress } from '../../../../shared/window-metadata'

/**
 * How far a progress report fills its card, from 0 to 1. A report without a percentage
 * (indeterminate) fills the whole card.
 */
export function progressShare(progress: WindowProgress): number {
  if (progress.state === 'indeterminate' || progress.value === null) return 1
  return Math.min(1, Math.max(0, progress.value / 100))
}

/** The sweep's band, as a share of the filled part it moves across. */
export const SWEEP_BAND = 0.3

export interface ProgressLayers {
  /** The filled part, from the card's left edge. */
  filled: { x: number; width: number }
  /** The part not yet filled, dimmed; none when the report fills the card. */
  rest?: { x: number; width: number }
  /** A sweep moves across the filled part: rightwards for a percentage, leftwards without one. */
  sweep?: 'forward' | 'reverse'
  /** A stopped report marks where it stopped. */
  edge?: number
}

/**
 * The minimap's drawing of a report on a card's rectangle: progress only adds light, so the
 * card keeps its own colour. The rectangle is already a light block, so the unfilled part is
 * dimmed instead of the filled part lightened.
 */
export function progressLayers(
  progress: WindowProgress,
  card: { x: number; width: number },
): ProgressLayers {
  const width = card.width * progressShare(progress)
  const filled = { x: card.x, width }
  const rest = width < card.width ? { x: card.x + width, width: card.width - width } : undefined
  if (progress.state === 'indeterminate') return { filled, sweep: 'reverse' }
  if (progress.state === 'normal') return { filled, rest, sweep: 'forward' }
  if (progress.state === 'error') return { filled, rest, edge: card.x + width }
  return { filled, rest }
}
