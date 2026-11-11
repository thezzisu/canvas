export interface NavigationOrder {
  canvases: string[]
  sources: string[]
}
export type NavigationOrderKind = keyof NavigationOrder

/** Keep only live IDs, retaining unmentioned/new entries in their existing order. */
export function orderedIds(current: readonly string[], proposed: readonly string[]): string[] {
  const remaining = new Set(current)
  return [...proposed.filter((id) => remaining.delete(id)), ...remaining]
}
