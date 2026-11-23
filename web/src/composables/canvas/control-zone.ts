import { computed, onScopeDispose, ref, watch, type Ref } from 'vue'
import type { useVueFlow } from '@vue-flow/core'
import { unrefElement, useEventListener, type MaybeComputedElementRef } from '@vueuse/core'
import { uiZoom } from '../ui-scale'
import { useDocumentFocus } from '../document-focus'
import {
  inZone,
  nextZone,
  overlaps,
  within,
  ZONE_EXIT_MARGIN,
  zoneOf,
  type Point,
  type Rect,
  type ZoneState,
} from '../../utils/canvas/control-zone'

/**
 * How the canvas controls at the bottom left look and take the pointer, as one zone
 * (utils/canvas/control-zone.ts). One value applies to every control, so the minimap and the
 * toolbar always share one opacity:
 * - `engaged`: the pointer came into the zone from outside a terminal. Opaque and usable.
 * - `yielding`: it came in from the focused terminal's content. Faint; it passes through.
 * - `covering`: the pointer is on the focused terminal, which a control lies over. Dimmed; it
 *   passes through.
 * - undefined: at rest.
 */
export type ControlsYield = 'engaged' | 'yielding' | 'covering' | undefined

const box = (element: Element): Rect => {
  const { left, top, right, bottom } = element.getBoundingClientRect()
  return { left, top, right, bottom }
}
const mouse = (event: PointerEvent) => event.pointerType === 'mouse'

/** The controls' zone, from where the pointer moves. */
export function useControlZone(options: {
  enabled(): boolean
  surface: MaybeComputedElementRef<HTMLElement | undefined>
  controls: MaybeComputedElementRef[]
  /** Changes whenever the camera, the focused card or the interface scale does. */
  geometry(): unknown
}) {
  const { activeElement, windowFocused } = useDocumentFocus()
  /** The focused terminal's content, which the controls yield to. */
  const host = computed(() => {
    if (!options.enabled()) return
    const active = activeElement.value
    if (!windowFocused.value || !active?.matches('.terminal-desktop-input, .terminal-mobile-input'))
      return
    const element = active.closest<HTMLElement>('.terminal-host')
    return element && unrefElement(options.surface)?.contains(element) ? element : undefined
  })
  const controls = () =>
    options.controls
      .map((control) => unrefElement(control))
      .filter((element): element is HTMLElement => !!element && element.isConnected)

  const state = ref<ZoneState>('idle')
  const covering = ref(false)
  let point: Point | undefined
  let held = false
  /** The pointer's last place was the focused terminal's content, outside the zone. */
  let fromTerminal = false

  /** The pointer is on the focused terminal itself, not on a card or dialog above it. */
  function onTerminal(at: Point, elements: HTMLElement[]) {
    const element = host.value
    if (!element || !within(box(element), at)) return false
    const hit = document
      .elementsFromPoint(at.x, at.y)
      .find((item) => !elements.some((control) => control.contains(item)))
    return !!hit && element.contains(hit)
  }
  function update() {
    const elements = controls(),
      rects = elements.map(box),
      zone = zoneOf(rects)
    const at = point
    if (!at) {
      covering.value = false
      if (!held) state.value = 'idle'
      return
    }
    const inside = inZone(zone, at),
      terminal = onTerminal(at, elements),
      area = host.value ? box(host.value) : undefined
    // A control lies over the focused terminal, so there is something to yield to.
    const yieldable = !!area && rects.some((rect) => overlaps(rect, area))
    state.value = nextZone(state.value, {
      inside,
      near: inZone(zone, at, ZONE_EXIT_MARGIN),
      held,
      fromTerminal,
      yieldable,
    })
    fromTerminal = terminal && !inside
    covering.value = terminal && yieldable
  }

  // Only a mouse has a hovering pointer; touch and pen leave the zone as it is.
  useEventListener(
    window,
    'pointermove',
    (event: PointerEvent) => {
      if (!mouse(event)) return
      point = { x: event.clientX, y: event.clientY }
      update()
    },
    { capture: true, passive: true },
  )
  // Leaving the window: what comes back in comes from outside.
  useEventListener(
    window,
    'pointerout',
    (event: PointerEvent) => {
      if (!mouse(event) || event.relatedTarget) return
      point = undefined
      fromTerminal = false
      update()
    },
    { passive: true },
  )
  useEventListener(window, 'blur', () => {
    held = false
    point = undefined
    fromTerminal = false
    update()
  })

  // A press on the yielding zone where the focused terminal is not under it only wakes the zone:
  // the press, its release and its click are swallowed, so nothing under the controls is clicked
  // and the terminal keeps its focus. A press over the terminal passes to it.
  let swallowing = false
  const swallow = (event: Event) => {
    if (!swallowing) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  useEventListener(
    window,
    'pointerdown',
    (event: PointerEvent) => {
      if (!mouse(event)) return
      held = true
      point = { x: event.clientX, y: event.clientY }
      if (
        state.value === 'yielding' &&
        inZone(zoneOf(controls().map(box)), point) &&
        !(event.target instanceof Node && host.value?.contains(event.target))
      ) {
        swallowing = true
        state.value = 'engaged'
      }
      swallow(event)
    },
    { capture: true },
  )
  useEventListener(
    window,
    'pointerup',
    (event: PointerEvent) => {
      if (!mouse(event)) return
      held = false
      update()
      if (!swallowing) return
      swallow(event)
      // What the release brings in this task, its click among it, is swallowed too.
      setTimeout(() => (swallowing = false))
    },
    { capture: true },
  )
  for (const type of ['mousedown', 'mouseup', 'click', 'auxclick', 'contextmenu'])
    useEventListener(window, type, swallow, { capture: true })
  useEventListener(window, 'pointercancel', () => {
    held = false
    swallowing = false
  })

  // Cards, the camera and the controls move under a still pointer. VueFlow writes a card's
  // transform after its own store update, so they are measured in the next frame.
  let frame = 0
  const later = () => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(update)
  }
  watch([options.geometry, host, () => controls().length], later, { flush: 'post' })
  onScopeDispose(() => cancelAnimationFrame(frame))

  return computed<ControlsYield>(() => {
    if (state.value !== 'idle') return state.value
    return covering.value ? 'covering' : undefined
  })
}

export interface CanvasControls {
  toolbar: Ref<HTMLElement | undefined>
  minimap: Ref<{ $el: HTMLElement } | undefined>
  /** What the zone of both does now; the stage carries it for both controls. */
  state: Readonly<Ref<ControlsYield>>
}
/**
 * The canvas's minimap and toolbar, and their zone. Created before the rest of the canvas, so
 * its window listeners run first: a wake press is swallowed before any other part sees it.
 */
export function useCanvasControls(scene: {
  flow: ReturnType<typeof useVueFlow>
  view: { autoYieldControls: boolean }
  surface: Ref<HTMLElement | undefined>
}): CanvasControls {
  const { activeElement } = useDocumentFocus()
  const toolbar = ref<HTMLElement>(),
    minimap = ref<{ $el: HTMLElement }>()
  const state = useControlZone({
    enabled: () => scene.view.autoYieldControls,
    surface: scene.surface,
    controls: [toolbar, () => minimap.value?.$el],
    geometry: () => {
      const { x, y, zoom } = scene.flow.viewport.value,
        id = activeElement.value?.closest<HTMLElement>('.vue-flow__node')?.dataset.id
      const node = id ? scene.flow.findNode(id) : undefined
      return [
        uiZoom.value,
        x,
        y,
        zoom,
        node?.computedPosition.x,
        node?.computedPosition.y,
        node?.dimensions.width,
        node?.dimensions.height,
      ].join(',')
    },
  })
  return { toolbar, minimap, state }
}
