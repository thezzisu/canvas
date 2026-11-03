import type { GraphNode } from '@vue-flow/core'

/** SVG paints in document order; VueFlow already computes the canvas elevation. */
export function minimapOrder(nodes: readonly GraphNode[]): GraphNode[] {
  return [...nodes].sort((left, right) => (left.computedPosition.z ?? 0) - (right.computedPosition.z ?? 0))
}
