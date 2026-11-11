export interface RingCard {
  id: string
  width: number
  height: number
}
export interface RingPlacement extends RingCard {
  x: number
  y: number
}
/** Where one card's centre sits, so re-ordering the ring around it never moves that card. */
export interface RingPin {
  id: string
  x: number
  y: number
}

const GAP = 96

/**
 * Place cards evenly around a circle, in order, clockwise from the top. Neighbours are
 * far enough apart that one card fills the view while the rest stay outside it. With a
 * pin, the ring is rotated and moved so the pinned card keeps its exact position.
 */
export function ringLayout(cards: readonly RingCard[], pin?: RingPin): RingPlacement[] {
  const count = cards.length
  if (!count) return []
  const span = Math.max(...cards.map((card) => Math.hypot(card.width, card.height))) + GAP
  const radius = count === 1 ? 0 : span / (2 * Math.sin(Math.PI / count))
  const pinned = pin ? cards.findIndex((card) => card.id === pin.id) : -1
  const step = (2 * Math.PI) / count
  const angle = (index: number) => (index - Math.max(pinned, 0)) * step
  const centre = pin && pinned >= 0 ? { x: pin.x, y: pin.y + radius } : { x: 0, y: 0 }
  return cards.map((card, index) => ({
    ...card,
    x: centre.x + radius * Math.sin(angle(index)) - card.width / 2,
    y: centre.y - radius * Math.cos(angle(index)) - card.height / 2,
  }))
}

/** The next card around the ring; a ring of one has no neighbour. */
export function ringNeighbour<T extends { id: string }>(
  cards: readonly T[],
  currentId: string,
  step: 1 | -1,
): T | undefined {
  const index = cards.findIndex((card) => card.id === currentId)
  return index < 0 || cards.length < 2
    ? undefined
    : cards[(index + step + cards.length) % cards.length]
}
