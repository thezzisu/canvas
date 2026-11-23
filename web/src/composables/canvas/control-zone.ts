import { computed, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue'
import type { useVueFlow } from '@vue-flow/core'
import { unrefElement, useEventListener, type MaybeComputedElementRef } from '@vueuse/core'
import { uiZoom } from '../ui-scale'
import { useDocumentFocus } from '../document-focus'
import {
  inZone,
  leftZone,
  movedZone,
  overlaps,
  restingZone,
  within,
  ZONE_EXIT_MARGIN,
  zoneLook,
  zoneOf,
  type ControlsLook,
  type Point,
  type Rect,
  type ZonePlace,
} from '../../utils/canvas/control-zone'

export type { ControlsLook }

const box = (element: Element): Rect => {
  const { left, top, right, bottom } = element.getBoundingClientRect()
  return { left, top, right, bottom }
}
const mouse = (event: PointerEvent) => event.pointerType === 'mouse'

/**
 * The controls' zone (utils/canvas/control-zone.ts): one look for all of them, so the minimap and
 * the toolbar always share one opacity. Only the pointer moving, pressing or releasing changes
 * what the zone does; focus and geometry only refresh whether the pointer is on the focused
 * terminal under the zone.
 */
export function useControlZone(options: {
  enabled(): boolean
  surface: MaybeComputedElementRef<HTMLElement | undefined>
  controls: MaybeComputedElementRef[]
  /** Changes whenever the camera, the focused card or the interface scale does. */
  geometry(): unknown
}) {
  // The page's focus, not the window's: another application or a window over this one (an
  // input method's candidates) takes the window's focus while the terminal keeps the page's.
  const { activeElement } = useDocumentFocus()
  /** The focused terminal's content, which the controls yield to. */
  const host = computed(() => {
    if (!options.enabled()) return
    const active = activeElement.value
    if (!active?.matches('.terminal-desktop-input, .terminal-mobile-input')) return
    const element = active.closest<HTMLElement>('.terminal-host')
    return element && unrefElement(options.surface)?.contains(element) ? element : undefined
  })
  const controls = () =>
    options.controls
      .map((control) => unrefElement(control))
      .filter((element): element is HTMLElement => !!element && element.isConnected)

  const memory = shallowRef(restingZone)
  const covering = ref(false)
  let point: Point | undefined
  let held = false

  /** What the pointer is over at `at`, with the controls and the focused terminal as they are. */
  function measure(at: Point): ZonePlace {
    const elements = controls(),
      rects = elements.map(box),
      zone = zoneOf(rects),
      element = host.value,
      area = element && box(element)
    const inside = inZone(zone, at)
    // On the terminal itself, not on a card or dialog above it.
    const hit =
      area && within(area, at)
        ? document
            .elementsFromPoint(at.x, at.y)
            .find((item) => !elements.some((control) => control.contains(item)))
        : undefined
    return {
      inside,
      near: inZone(zone, at, ZONE_EXIT_MARGIN),
      onTerminal: !inside && !!hit && !!element?.contains(hit),
      yieldable: !!area && rects.some((rect) => overlaps(rect, area)),
    }
  }
  /** Shows what the pointer's last place is over now; what the zone does stays. */
  function refresh() {
    const place = point && measure(point)
    covering.value = !!place && place.onTerminal && place.yieldable
  }
  function moved(at: Point) {
    point = at
    const place = measure(at)
    memory.value = movedZone(memory.value, place, held)
    covering.value = place.onTerminal && place.yieldable
  }

  // Only a mouse has a hovering pointer; touch and pen leave the zone as it is.
  useEventListener(
    window,
    'pointermove',
    (event: PointerEvent) => {
      if (mouse(event)) moved({ x: event.clientX, y: event.clientY })
    },
    { capture: true, passive: true },
  )
  // Reported leaving the page, as when a window opens under a still pointer: nothing shown
  // changes, and what comes in next comes from outside.
  useEventListener(
    window,
    'pointerout',
    (event: PointerEvent) => {
      if (mouse(event) && !event.relatedTarget) memory.value = leftZone(memory.value)
    },
    { passive: true },
  )

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
      const at = { x: event.clientX, y: event.clientY }
      moved(at)
      if (
        memory.value.state === 'yielding' &&
        inZone(zoneOf(controls().map(box)), at) &&
        !(event.target instanceof Node && host.value?.contains(event.target))
      ) {
        swallowing = true
        memory.value = { ...memory.value, state: 'engaged' }
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
      moved({ x: event.clientX, y: event.clientY })
      if (!swallowing) return
      swallow(event)
      // What the release brings in this task, its click among it, is swallowed too.
      setTimeout(() => (swallowing = false))
    },
    { capture: true },
  )
  for (const type of ['mousedown', 'mouseup', 'click', 'auxclick', 'contextmenu'])
    useEventListener(window, type, swallow, { capture: true })
  // A gesture's release may never come back to this window.
  const endGesture = () => {
    held = false
    swallowing = false
  }
  useEventListener(window, ['pointercancel', 'blur'], endGesture)

  // Cards, the camera, the controls and the focus move under a still pointer. VueFlow writes a
  // card's transform after its own store update, so they are measured in the next frame.
  let frame = 0
  const later = () => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(refresh)
  }
  watch([options.geometry, host, () => controls().length], later, { flush: 'post' })
  onScopeDispose(() => cancelAnimationFrame(frame))

  return computed(() => zoneLook(memory.value, covering.value))
}

export interface CanvasControls {
  toolbar: Ref<HTMLElement | undefined>
  minimap: Ref<{ $el: HTMLElement } | undefined>
  /** What the zone of both does now; the stage carries it for both controls. */
  state: Readonly<Ref<ControlsLook>>
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
