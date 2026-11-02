export interface CardBounds { id: string; x: number; y: number; width: number; height: number }

/** Snap visible card edges before falling back to the canvas lattice. Native
 * terminal dimensions can be fractional and need not be multiples of the grid. */
export function snapCardPosition(card: CardBounds, others: readonly CardBounds[], zoom: number, grid = 24) {
  const threshold = 8 / Math.max(.08, zoom)
  const snapAxis = (axis: 'x' | 'y', extent: 'width' | 'height') => {
    const value = card[axis]
    let nearest: number | undefined, distance = threshold
    for (const other of others) {
      if (other.id === card.id) continue
      for (const edge of [other[axis], other[axis] + other[extent]]) {
        for (const candidate of [edge, edge - card[extent]]) {
          const delta = Math.abs(candidate - value)
          if (delta <= distance && (nearest === undefined || delta < distance)) {
            nearest = candidate; distance = delta
          }
        }
      }
    }
    return nearest ?? Math.round(value / grid) * grid
  }
  return { x: snapAxis('x', 'width'), y: snapAxis('y', 'height') }
}
