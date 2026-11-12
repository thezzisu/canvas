/** Canvases the application generates. A stored document of the same id only owns their background. */
export const systemCanvases = ['overview', 'working-set'] as const
export type SystemCanvas = (typeof systemCanvases)[number]
export const isSystemCanvas = (id: string | undefined): id is SystemCanvas =>
  systemCanvases.includes(id as SystemCanvas)
