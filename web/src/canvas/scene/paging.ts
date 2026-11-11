import { computed, nextTick, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  adjacentPage,
  pageViewport,
  retainPage,
  type OverviewPage,
  type PageDirection,
} from '../overview-paging'
import { ringNeighbour } from '../ring-layout'
import type { CanvasScene } from './scene'

const ease = (value: number) => 1 - (1 - value) ** 3
/** Camera moves between whole windows share one short, decelerating motion. */
export const pageMotion = (duration: number) => ({ duration, interpolate: 'linear', ease }) as const

/** One window fills the view at a time: Overview's optional mode, and the working set always. */
export function useCanvasPaging(scene: CanvasScene) {
  const { t } = useI18n()
  const { nodes, getViewport, setViewport } = scene.flow
  /** Overview's own choice; the working set is always shown window by window. */
  const overviewPaged = ref(false)
  const active = computed(
    () =>
      scene.kind.value === 'working-set' ||
      (scene.kind.value === 'overview' && overviewPaged.value),
  )
  const current = shallowRef<OverviewPage>()
  // Vertical navigation keeps its intended column even when a short row clamps it.
  const preferredX = ref<number>()
  const pages = computed<OverviewPage[]>(() =>
    nodes.value
      .filter((node) => node.type === 'terminal' || (node.type === 'create' && node.data.spaceId))
      .map((node) => ({
        id: node.type === 'terminal' ? `${node.data.sourceId}/${node.data.windowId}` : node.id,
        // A space may wrap into several visual rows; cards in one row share their y.
        row:
          scene.kind.value === 'working-set'
            ? 'ring'
            : `${node.data.sourceId}/${node.data.spaceId}/${node.position.y}`,
        ...node.position,
        width: node.data.width,
        height: node.data.height,
      })),
  )
  const arrows = {
    left: { key: 'ArrowLeft', label: 'app.previousWindow', icon: 'i-lucide-chevron-left' },
    up: { key: 'ArrowUp', label: 'app.previousSpace', icon: 'i-lucide-chevron-up' },
    down: { key: 'ArrowDown', label: 'app.nextSpace', icon: 'i-lucide-chevron-down' },
    right: { key: 'ArrowRight', label: 'app.nextWindow', icon: 'i-lucide-chevron-right' },
  } as const
  /** The ring only has a previous and a next window. */
  const directions = computed(() =>
    (scene.kind.value === 'working-set'
      ? (['left', 'right'] as const)
      : (['left', 'up', 'down', 'right'] as const)
    ).map((direction) => ({
      direction,
      key: arrows[direction].key,
      label: t(arrows[direction].label),
      icon: arrows[direction].icon,
    })),
  )

  function frame() {
    const element = scene.surface.value
    return element?.clientWidth && element.clientHeight
      ? { width: element.clientWidth, height: element.clientHeight }
      : undefined
  }
  function select(page: OverviewPage | undefined) {
    current.value = page
    preferredX.value = page ? page.x + page.width / 2 : undefined
    pin()
  }
  /** The window on screen keeps its place when the ring around it re-forms. */
  function pin() {
    if (scene.kind.value !== 'working-set') return
    const id = current.value?.id
    scene.graph.pinRing(
      nodes.value.find((node) => `${node.data.sourceId}/${node.data.windowId}` === id),
    )
  }
  function neighbor(direction: PageDirection) {
    const id = current.value?.id || ''
    if (scene.kind.value === 'working-set')
      return direction === 'left' || direction === 'right'
        ? ringNeighbour(pages.value, id, direction === 'right' ? 1 : -1)
        : undefined
    return adjacentPage(pages.value, id, direction, preferredX.value)
  }
  /** Centre the current window, keeping it through sorting, moves and removal. */
  async function fit(animate = false) {
    scene.camera.resetGesture()
    const bounds = frame()
    if (!active.value || scene.focus.terminal.value || !bounds) return
    const initial = current.value
      ? pages.value
      : pages.value.filter((page) => !page.id.startsWith('create-'))
    const page = retainPage(
      initial.length ? initial : pages.value,
      current.value?.id || '',
      current.value,
      getViewport(),
      bounds,
    )
    if (page?.id !== current.value?.id || preferredX.value === undefined) select(page)
    else current.value = page
    if (!page) return
    const duration = animate && !scene.reducedMotion.value ? 200 : 0
    const transition = setViewport(pageViewport(page, bounds), pageMotion(duration))
    // VueFlow does not resolve an interrupted animation. Only immediate camera
    // writes can be awaited by mode/fullscreen lifecycle code.
    if (!duration) await transition
    scene.camera.save()
  }
  function move(direction: PageDirection) {
    if (!active.value || scene.focus.terminal.value) return
    const horizontal = direction === 'left' || direction === 'right'
    if (horizontal || preferredX.value === undefined) select(current.value)
    const page = neighbor(direction)
    if (!page) return
    scene.focus.clearContent()
    scene.windows.cancelReveal()
    if (horizontal) select(page)
    else {
      current.value = page
      pin()
    }
    void fit(true)
  }
  /** Switch Overview between the free camera and window-by-window browsing. */
  async function toggle() {
    scene.focus.clearContent()
    scene.camera.resetGesture()
    preferredX.value = undefined
    if (!overviewPaged.value) scene.camera.save()
    overviewPaged.value = !overviewPaged.value
    await nextTick()
    if (active.value) await fit(true)
    else await scene.camera.restore()
    scene.camera.save()
  }
  function showWindow(target: { sourceId: string; windowId: string }) {
    select(pages.value.find((page) => page.id === `${target.sourceId}/${target.windowId}`))
  }
  function reset(paged = false) {
    overviewPaged.value = paged
    current.value = undefined
    preferredX.value = undefined
  }

  return {
    overviewPaged,
    active,
    current,
    pages,
    directions,
    frame,
    select,
    showWindow,
    neighbor,
    fit,
    move,
    toggle,
    reset,
    forgetColumn() {
      preferredX.value = undefined
    },
  }
}
export type CanvasPaging = ReturnType<typeof useCanvasPaging>
