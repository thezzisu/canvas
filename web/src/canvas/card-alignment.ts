export interface CardBounds {
  id: string
  x: number
  y: number
  width: number
  height: number
}

/** Resize libraries may measure integer offsets; preserve our exact CSS origin. */
export function resizeFromDelta(origin: CardBounds, from: CardBounds, to: CardBounds): CardBounds {
  return {
    id: origin.id,
    x: origin.x + (to.x - from.x),
    y: origin.y + (to.y - from.y),
    width: origin.width + (to.width - from.width),
    height: origin.height + (to.height - from.height),
  }
}

function snapCoordinate(
  value: number,
  targets: number[],
  zoom: number,
  grid: number,
  min = -Infinity,
  max = Infinity,
) {
  let nearest: number | undefined,
    distance = 8 / Math.max(0.08, zoom)
  for (const target of targets) {
    if (target < min || target > max) continue
    const delta = Math.abs(target - value)
    if (delta <= distance && (nearest === undefined || delta < distance)) {
      nearest = target
      distance = delta
    }
  }
  return nearest ?? Math.max(min, Math.min(max, Math.round(value / grid) * grid))
}

/** Native terminal dimensions can be fractional and need not match the lattice. */
export function snapCardPosition(
  card: CardBounds,
  others: readonly CardBounds[],
  zoom: number,
  grid = 24,
) {
  const peers = others.filter((other) => other.id !== card.id)
  const axis = (position: 'x' | 'y', extent: 'width' | 'height') =>
    snapCoordinate(
      card[position],
      peers
        .flatMap((other) => [other[position], other[position] + other[extent]])
        .flatMap((edge) => [edge, edge - card[extent]]),
      zoom,
      grid,
    )
  return { x: axis('x', 'width'), y: axis('y', 'height') }
}

/** Move only the dragged edges; the opposite edges stay fixed, including limits. */
export function snapCardResize(
  origin: CardBounds,
  current: CardBounds,
  others: readonly CardBounds[],
  zoom: number,
  minimum: { width: number; height: number },
  grid = 24,
): CardBounds {
  const result = { ...current }
  for (const [position, extent, maximum] of [
    ['x', 'width', 4000],
    ['y', 'height', 3000],
  ] as const) {
    if (current[position] === origin[position] && current[extent] === origin[extent]) continue
    const leading = current[position] !== origin[position]
    const anchor = leading ? origin[position] + origin[extent] : origin[position]
    const edge = leading ? current[position] : current[position] + current[extent]
    const targets = others
      .filter((other) => other.id !== origin.id)
      .flatMap((other) => [other[position], other[position] + other[extent]])
    const snapped = snapCoordinate(
      edge,
      targets,
      zoom,
      grid,
      leading ? anchor - maximum : anchor + minimum[extent],
      leading ? anchor - minimum[extent] : anchor + maximum,
    )
    result[position] = leading ? snapped : anchor
    result[extent] = Math.abs(snapped - anchor)
  }
  return result
}
