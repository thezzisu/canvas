export interface CanvasInstance { id: string; name: string; base: string; username?: string; builtin?: true }
const unconfigured: CanvasInstance = { id: '', name: '', base: '' }

/** A standalone frontend has no implicit endpoint, including persisted built-in entries. */
export function instanceConfiguration(saved: CanvasInstance[], activeId: string, builtin?: CanvasInstance) {
  const instances = builtin
    ? saved.some(instance => instance.base === builtin.base) ? saved : [builtin, ...saved]
    : saved.filter(instance => !instance.builtin)
  return { instances, active: instances.find(instance => instance.id === activeId) || instances[0] || unconfigured }
}
