export const layoutFields = ['x', 'y', 'width', 'height'] as const
export type LayoutField = (typeof layoutFields)[number]
export type LayoutGeometry = Record<LayoutField, number>
export type LayoutUpdate = {
  id: string
  expected?: Partial<LayoutGeometry>
} & Partial<LayoutGeometry>
