import { computed, inject, onBeforeUnmount, onUpdated, watch, type InjectionKey, type Ref } from 'vue'

export interface LayoutEditing {
  active: Readonly<Ref<boolean>>
  busy: Readonly<Ref<boolean>>
  selected: Ref<string>
  start(id: string, bounds: { x: number; y: number; width: number; height: number }): void
  end(id: string, width: number, height: number, x?: number, y?: number): void
}
export const layoutEditingKey: InjectionKey<LayoutEditing> = Symbol('layout-editing')
export function useLayoutCard(root: Ref<HTMLElement | undefined>) {
  const layout = inject(layoutEditingKey, undefined)
  const editing = computed(() => !!layout?.active.value)
  const properties = ['position', 'width', 'height', 'left', 'top', 'right', 'bottom', 'flex', 'visibility'] as const
  const frozen = new Map<HTMLElement, { styles: Array<{ name: string; value: string; priority: string }>; inert: boolean }>()
  function restore() {
    for (const [element, value] of frozen) {
      for (const { name, value: original, priority } of value.styles) {
        if (original) element.style.setProperty(name, original, priority); else element.style.removeProperty(name)
      }
      element.inert = value.inert
    }
    frozen.clear()
  }
  // Keep each content host and iframe parent in place, at its last layout size.
  // visibility hides painting; it deliberately does not claim to suspend arbitrary iframe scripts.
  function freezeNewContent() {
    const element = root.value
    if (!editing.value || !element) return
    const contents = [...element.querySelectorAll<HTMLElement>(':scope > .card-content, :scope > .capture-toolbar')].filter(node => !frozen.has(node))
    const measurements = contents.map(node => ({ node, width: node.offsetWidth, height: node.offsetHeight, left: node.offsetLeft, top: node.offsetTop }))
    for (const { node, width, height, left, top } of measurements) {
      frozen.set(node, { styles: properties.map(name => ({ name, value: node.style.getPropertyValue(name), priority: node.style.getPropertyPriority(name) })), inert: node.inert })
      Object.assign(node.style, { position: 'absolute', width: `${width}px`, height: `${height}px`, left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto', flex: 'none', visibility: 'hidden' })
      node.inert = true
    }
  }
  watch([editing, root], () => { restore(); freezeNewContent() }, { flush: 'sync' })
  // A late capture/connection can add a host while editing; freeze only that new
  // direct child, without moving or remeasuring already retained content.
  onUpdated(freezeNewContent)
  onBeforeUnmount(restore)
  return { editing, layout }
}
