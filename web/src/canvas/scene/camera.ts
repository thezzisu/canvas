import { computed, nextTick, ref, shallowRef, watch } from 'vue'
import type { Node, NodeMouseEvent } from '@vue-flow/core'
import { useEventListener, useResizeObserver, watchDebounced } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import { apiContext, apiRevision, isCurrentApi } from '../../api/api'
import { activeInstance, activeInstanceId } from '../../instances/instances'
import { notify } from '../../lib/notify'
import { uiZoom } from '../../app/ui-scale'
import { canvasFrame, preserveCanvasCenter, type CanvasFrame } from '../../lib/viewport'
import { useCanvasNavigation } from '../canvas-navigation'
import { anchoredViewport } from '../canvas-jump'
import {
  cameraFromViewport,
  recallCanvasLocation,
  recallFreeCanvasLocation,
  resolveCanvasLocation,
  restoreCanvasPage,
  viewportFromCamera,
  type CanvasLocation,
} from '../canvas-location'
import { pageViewport } from '../overview-paging'
import { useTerminalOverlays } from '../terminal-overlays'
import { isCard, windowNode } from './graph'
import { pageMotion } from './paging'
import type { CanvasScene } from './scene'

const FIT = { padding: 0.14, maxZoom: 1 }

/** Where the canvas is looking: restoring a view, following the user, and fitting cards. */
export function useCanvasCamera(scene: CanvasScene) {
  const { workspace, shell, session, view, flow } = scene
  const { t } = useI18n()
  const {
    nodes,
    fitView,
    zoomIn,
    zoomOut,
    setViewport,
    getViewport,
    getNodesInitialized,
    findNode,
  } = flow
  const bounds = (node: Node) => ({
    ...node.position,
    width: node.data.width,
    height: node.data.height,
  })
  /** The canvas whose first camera is still being applied; nothing is saved meanwhile. */
  let pending = ''
  let restoration = 0
  let frame: CanvasFrame | undefined
  let resizeFrame = 0

  // --- Fit control: alternates between the focused card and the whole canvas. ---
  const toolbar = ref<HTMLElement>()
  const toolbarTarget = ref<string>()
  const fittedCard = ref(false)
  /** Keeps a navigation fit aligned while the terminal's first native grid settles.
   * Explicit user interaction releases it; ordinary output never moves the camera. */
  const navigationFit = shallowRef<{ canvasId: string; id: string; pending: boolean }>()
  function cardWithFocus(active?: Element | null) {
    if (!active) return
    const body = active.closest('.card-content')
    if (!body || body.closest('[inert]') || active.closest('.card-content-activate')) return
    const id = body.closest<HTMLElement>('.vue-flow__node')?.dataset.id
    return nodes.value.find((node) => node.id === id && isCard(node))
  }
  function clearFit() {
    fittedCard.value = false
    toolbarTarget.value = undefined
    navigationFit.value = undefined
  }
  /** Focus moving into the toolbar keeps the card it came from as the Fit target. */
  function preserveFitTarget(event: FocusEvent) {
    const element = toolbar.value
    if (
      !element ||
      !(event.relatedTarget instanceof Node) ||
      !element.contains(event.relatedTarget)
    ) {
      clearFit()
      return
    }
    if (event.target instanceof Element && !element.contains(event.target))
      toolbarTarget.value = cardWithFocus(event.target)?.id
  }
  const fitTarget = computed(() => {
    const active = scene.focus.activeElement.value
    if (
      scene.focus.maximized.value ||
      !active ||
      (!scene.focus.windowFocused.value && !(active instanceof HTMLIFrameElement))
    )
      return
    return toolbar.value?.contains(active)
      ? nodes.value.find((node) => node.id === toolbarTarget.value)
      : cardWithFocus(active)
  })
  const fitsCard = computed(
    () => !scene.paging.active.value && !!fitTarget.value && !fittedCard.value,
  )
  watch(
    [() => fitTarget.value?.id, scene.route.canvasId, scene.paging.active],
    () => {
      fittedCard.value = false
    },
    { flush: 'sync' },
  )
  watch([scene.route.canvasId, activeInstanceId, scene.paging.active, apiRevision], clearFit, {
    flush: 'sync',
  })

  const duration = (value: number) => (scene.reducedMotion.value ? 0 : value)
  const fitAll = (ms = duration(200)) => fitView({ ...FIT, duration: ms })
  function centre(node: Node, ms = 0) {
    const area = scene.paging.frame()
    if (area) return setViewport(pageViewport(bounds(node), area), pageMotion(ms))
  }
  function fit() {
    if (!nodes.value.length) return
    navigationFit.value = undefined
    if (scene.paging.active.value) {
      void scene.paging.fit(true)
      return
    }
    const target = fitTarget.value
    if (target && !fittedCard.value && scene.paging.frame()) {
      fittedCard.value = true
      void centre(target, duration(200))
    } else {
      fittedCard.value = false
      void fitAll()
    }
  }
  function zoom(step: typeof zoomIn) {
    clearFit()
    void step({ duration: duration(150) })
  }
  /** Bring one card into view without focusing, maximizing or editing it. */
  async function show(node: Node) {
    if (!isCard(node) || scene.focus.maximized.value) return
    clearFit()
    scene.focus.clearContent()
    const canvasId = scene.route.canvasId.value,
      context = apiContext()
    resetGesture()
    scene.windows.cancelReveal()
    // Blurring can remove a focus-exempt window from the filtered overview.
    const request = (navigationFit.value = { canvasId, id: node.id, pending: true })
    await nextTick()
    if (
      !isCurrentApi(context) ||
      scene.route.canvasId.value !== canvasId ||
      scene.focus.maximized.value ||
      navigationFit.value !== request
    )
      return
    const target = nodes.value.find((item) => item.id === node.id && item.type === node.type)
    if (!target || !scene.paging.frame()) return
    if (scene.paging.active.value) {
      if (target.type !== 'terminal') return
      scene.paging.showWindow(target.data)
      void scene.paging.fit(true)
    } else navigationFit.value = { ...request, pending: false }
  }
  const followed = computed(() => {
    const request = navigationFit.value
    return request &&
      !request.pending &&
      request.canvasId === scene.route.canvasId.value &&
      !scene.focus.maximized.value &&
      !scene.paging.active.value
      ? nodes.value.find((node) => node.id === request.id)
      : undefined
  })
  watch(
    () => {
      const node = followed.value
      return node
        ? `${node.position.x}/${node.position.y}/${node.data.width}/${node.data.height}`
        : ''
    },
    () => {
      if (followed.value) void centre(followed.value, duration(200))
    },
    { flush: 'post' },
  )

  // --- The address: what is saved, and how a request becomes a camera. ---
  function location(): CanvasLocation {
    const instance = activeInstance.value.id,
      canvas = scene.route.canvasId.value,
      area = scene.paging.frame(),
      page = scene.paging.current.value
    const viewport =
      area && scene.paging.active.value && page ? pageViewport(page, area) : getViewport()
    // A maximized card hides the canvas; the address keeps the camera it had.
    const camera =
      area && !scene.focus.maximized.value
        ? cameraFromViewport(viewport, area)
        : scene.route.current()?.camera
    return {
      instance,
      canvas,
      ...(camera ? { camera } : {}),
      ...(scene.kind.value === 'overview' && scene.paging.active.value
        ? { view: 'paged' as const }
        : {}),
      ...(scene.paging.active.value && page ? { page: page.id } : {}),
    }
  }
  /** `remember` forces the view into browser storage, as when the tab is being hidden. */
  function save(remember?: boolean) {
    if (pending || !session.authenticated || !workspace.resourcesLoaded) return
    if (scene.focus.maximized.value) {
      scene.route.save(location(), remember)
      return
    }
    const next = canvasFrame(scene.surface.value)
    // A phone's layout width changed (rotation, keyboard): re-centre before saving.
    if (shell.mobile && (!next || (frame && Math.abs(frame.layoutWidth - next.layoutWidth) >= 1))) {
      queueResize()
      return
    }
    if (next) frame = next
    scene.route.save(location(), remember)
  }
  function settled(request: typeof scene.route.request.value, actual = location()) {
    pending = ''
    frame = canvasFrame(scene.surface.value)
    scene.route.restored(request, actual)
    scene.morph.complete(request)
  }
  /** Apply the open request, or this canvas's remembered view, once its nodes are measured. */
  async function restore() {
    clearFit()
    const request = scene.route.request.value
    if (!session.authenticated || !workspace.resourcesLoaded) return
    const id = scene.route.canvasId.value,
      instance = activeInstance.value.id
    const attempt = ++restoration
    const current = () =>
      attempt === restoration &&
      id === scene.route.canvasId.value &&
      instance === activeInstance.value.id
    pending = id
    await nextTick()
    if (!current() || request !== scene.route.request.value) return
    const area = scene.paging.frame()
    if (!area) return
    const anchor = request?.anchor
    const anchored = anchor && windowNode(nodes.value, anchor)
    // Node positions are known before measurement, so the jump never paints the
    // destination at another camera. Restoration completes once nodes are ready.
    if (anchored) await setViewport(anchoredViewport(anchor, anchored.position))
    else if (anchor) scene.reveal.cancelJump()
    const initialized = new Set(getNodesInitialized.value.map((node) => node.id))
    if (nodes.value.some((node) => !initialized.has(node.id))) return
    if (anchored) {
      if (!current()) return
      settled(request)
      scene.reveal.finishJump(anchored)
      return
    }
    const revealed = scene.reveal.target(id)
    const target = request?.fitNodeId
      ? nodes.value.find((node) => node.id === request.fitNodeId)
      : revealed && windowNode(nodes.value, revealed)
    if (target) {
      const viewport = pageViewport(bounds(target), area)
      await setViewport(viewport)
      if (attempt !== restoration || scene.route.request.value !== request) return
      settled(request, { instance, canvas: id, camera: cameraFromViewport(viewport, area) })
      navigationFit.value = { canvasId: id, id: target.id, pending: false }
      if (revealed) void scene.reveal.show()
      return
    }
    if (request?.fitNodeId) notify.info(t('app.connectionNotVisible'))
    const own = scene.route.current()
    const saved = request?.fitAll
      ? undefined
      : request
        ? resolveCanvasLocation(
            request.location,
            workspace.canvases.map((canvas) => canvas.id),
          )
        : own && !!own.view === scene.paging.overviewPaged.value
          ? own
          : scene.paging.active.value
            ? recallCanvasLocation(localStorage, instance, id)
            : recallFreeCanvasLocation(localStorage, instance, id)
    if (request && saved) scene.paging.overviewPaged.value = saved.view === 'paged'
    if (scene.paging.active.value) {
      if (request && saved)
        scene.paging.select(restoreCanvasPage(saved, scene.paging.pages.value, area))
      await scene.paging.fit()
    } else {
      const viewport = saved?.camera ? viewportFromCamera(saved.camera, area) : undefined
      if (viewport) await setViewport(viewport)
      else if (nodes.value.length) await fitAll(0)
      else await setViewport({ x: area.width / 2, y: area.height / 2, zoom: 1 })
    }
    if (!current()) return
    settled(request)
    void scene.reveal.show()
  }
  /** VueFlow measured new nodes: finish a waiting restoration, then pending focus requests. */
  function nodesInitialized() {
    if (pending === scene.route.canvasId.value) void restore()
    // VueFlow mounts new node components after its own node-store update.
    // Waiting for that mount keeps focus from falling back to the document body.
    void nextTick().then(() => {
      scene.windows.focusNewNote()
      scene.windows.focusCreated()
      void scene.reveal.show()
    })
  }

  // --- Following the frame: resize, rotation, keyboard and fullscreen. ---
  function queueResize() {
    cancelAnimationFrame(resizeFrame)
    resizeFrame = requestAnimationFrame(() => {
      if (scene.paging.active.value) {
        void scene.paging.fit()
        return
      }
      if (!shell.mobile || scene.focus.maximized.value || pending) return
      const next = canvasFrame(scene.surface.value)
      if (!next) return
      const previous = frame
      frame = next
      const viewport = getViewport()
      const centred = preserveCanvasCenter(viewport, previous, next)
      if (centred === viewport) return
      const id = scene.route.canvasId.value
      void setViewport(centred).then(() => {
        if (id === scene.route.canvasId.value && !scene.focus.maximized.value) save()
      })
    })
  }
  useResizeObserver(scene.surface, queueResize)
  useEventListener(window, 'resize', queueResize)
  useEventListener(window, 'beforeunload', () => save())
  // The view at the moment the tab is hidden is the one to come back to.
  useEventListener(document, 'visibilitychange', () => save(document.hidden || undefined))
  watch([() => shell.viewport, uiZoom], () => void nextTick(queueResize))
  watchDebounced(getViewport, () => save(), { debounce: 160 })

  const navigation = useCanvasNavigation({
    getCanvasId: () => `${activeInstance.value.id}/${scene.route.canvasId.value}`,
    getViewport,
    setViewport,
    saveViewport: () => save(),
    onError: notify.error,
    blocked: () =>
      workspace.pending ||
      scene.menus.display.value ||
      shell.modalOpen ||
      scene.focus.maximized.value ||
      shell.sidebarOpen ||
      (shell.mobile && shell.connectionsOpen),
    mobile: () => shell.mobile,
    editing: () => scene.layout.editing.value,
    gestureCancelled: () => scene.layout.cancelGesture(),
    onNavigate: clearFit,
    paging: {
      enabled: () => scene.paging.active.value,
      canMove: (direction) => !!scene.paging.neighbor(direction),
      move: (direction) => scene.paging.move(direction),
      recenter: (animate) => scene.paging.fit(animate),
    },
    beforeFullscreen: () => {
      clearFit()
      shell.closePanels()
      scene.menus.canvas.value = false
    },
  })
  const resetGesture = navigation.resetPagingFeedback
  watch(
    navigation.surface,
    (element) => {
      scene.surface.value = element
    },
    { flush: 'sync' },
  )
  watch(
    navigation.fullscreen,
    async (value) => {
      shell.fullscreen = value
      shell.sidebarOpen = false
      await nextTick()
      frame = canvasFrame(scene.surface.value)
    },
    { immediate: true },
  )
  watch(
    () => shell.mobile,
    () => {
      if (!scene.layout.editing.value) navigation.touchCancel()
    },
  )

  const minimap = ref<{ $el: HTMLElement }>()
  const [toolbarOverlap, minimapOverlap] = useTerminalOverlays({
    enabled: () => view.autoYieldControls,
    surface: scene.surface,
    controls: [toolbar, () => minimap.value?.$el],
    geometry: () => {
      const viewport = getViewport(),
        id = scene.focus.activeElement.value?.closest<HTMLElement>('.vue-flow__node')?.dataset.id
      const node = id ? findNode(id) : undefined
      return [
        uiZoom.value,
        viewport.x,
        viewport.y,
        viewport.zoom,
        node?.computedPosition.x,
        node?.computedPosition.y,
        node?.dimensions.width,
        node?.dimensions.height,
      ].join(',')
    },
  })

  return {
    navigation,
    toolbar,
    minimap,
    toolbarOverlap,
    minimapOverlap,
    fitsCard,
    preserveFitTarget,
    clearFit,
    fit,
    fitAll,
    centre,
    zoomIn: () => zoom(zoomIn),
    zoomOut: () => zoom(zoomOut),
    show,
    showFromMinimap({ event, node }: NodeMouseEvent) {
      event.stopPropagation()
      void show(node)
    },
    /** Any user input ends a navigation fit; the camera is theirs again. */
    release() {
      navigationFit.value = undefined
    },
    resetGesture,
    location,
    save,
    restore,
    nodesInitialized,
    queueResize,
    /** Window-by-window browsing has no free pan, including with the middle button. */
    guardMiddleDrag(event: MouseEvent) {
      if (
        scene.paging.active.value &&
        event.button === 1 &&
        !(event.target as Element)?.closest('.terminal-host')
      ) {
        event.preventDefault()
        event.stopPropagation()
      }
    },
    /** Whether the first camera of this canvas is still being applied. */
    restoring: () => !!pending,
    /** Stop a camera animation before its graph is replaced. */
    halt: () => void setViewport(getViewport()),
    abandon() {
      pending = ''
      restoration++
    },
  }
}
export type CanvasCamera = ReturnType<typeof useCanvasCamera>
