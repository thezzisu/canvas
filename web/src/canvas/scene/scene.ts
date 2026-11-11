import {
  computed,
  inject,
  onScopeDispose,
  provide,
  ref,
  shallowRef,
  watch,
  type InjectionKey,
  type Ref,
} from 'vue'
import { useVueFlow } from '@vue-flow/core'
import { useEventListener } from '@vueuse/core'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRouter } from 'vue-router'
import { isCurrentApi } from '../../api/api'
import { notify } from '../../lib/notify'
import { useReducedMotion } from '../../lib/reduced-motion'
import { setDownloadContext } from '../../files/downloads'
import { addWindows, chooseWindowAction, shareCard } from '../../workspace/dialogs'
import { usePreferencePruning } from '../../workspace/preference-pruning'
import type SettingsDialog from '../../settings/SettingsDialog.vue'
import { useCardRemovalUndo } from '../card-removal-undo'
import { isSystemCanvas } from '../canvas-location'
import type { CanvasTarget } from '../canvas-jump'
import { useEditsStore } from '../../stores/edits'
import { useSessionStore } from '../../stores/session'
import { useShellStore, type ScanTarget } from '../../stores/shell'
import { useViewStore } from '../../stores/view'
import { useWorkspaceStore } from '../../stores/workspace'
import { isTerminalNode } from '../../api/types'
import { useCanvasCamera, type CanvasCamera } from './camera'
import { useCardActions, type CardActions } from './cards'
import { useCardFocus, type CardFocus } from './focus'
import { useCanvasGraph, type CanvasGraph } from './graph'
import { useCanvasLayout, type CanvasLayout } from './layout'
import { useCanvasMorph, type CanvasMorph } from './morph'
import { useCanvasPaging, type CanvasPaging } from './paging'
import { useWindowReveal, type WindowReveal } from './reveal'
import { useCanvasRoute, type CanvasRoute } from './route'
import { useCanvasWindows, type CanvasWindows } from './windows'

function stores() {
  return {
    workspace: useWorkspaceStore(),
    session: useSessionStore(),
    edits: useEditsStore(),
    shell: useShellStore(),
    view: useViewStore(),
  }
}
function menus() {
  return { display: ref(false), canvas: ref(false), create: ref(false) }
}

/**
 * Everything one canvas page shares. Each part owns one concern and reaches the
 * others through the scene, only from inside its functions, watchers and computeds.
 */
export interface CanvasScene extends ReturnType<typeof stores> {
  flow: ReturnType<typeof useVueFlow>
  /** The element the graph is drawn in; its size is the camera's frame. */
  surface: Ref<HTMLElement | undefined>
  reducedMotion: Readonly<Ref<boolean>>
  route: CanvasRoute
  /** Overview and the working set lay themselves out; only custom canvases are arranged by hand. */
  kind: Readonly<Ref<'overview' | 'working-set' | 'custom'>>
  custom: Readonly<Ref<boolean>>
  /** The custom canvas being shown. */
  canvas: Readonly<Ref<ReturnType<typeof useWorkspaceStore>['canvases'][number] | undefined>>
  name: Readonly<Ref<string>>
  menus: ReturnType<typeof menus>
  dialogs: {
    settingsDialog: Ref<InstanceType<typeof SettingsDialog> | undefined>
    settings(): void
    closeSettings(): void
    scan(target: ScanTarget): void
    addWindows: typeof addWindows
    shareCard: typeof shareCard
    windowMenu: typeof chooseWindowAction
  }
  removalUndo: ReturnType<typeof useCardRemovalUndo>
  focus: CardFocus
  graph: CanvasGraph
  paging: CanvasPaging
  camera: CanvasCamera
  morph: CanvasMorph
  layout: CanvasLayout
  windows: CanvasWindows
  reveal: WindowReveal
  cards: CardActions
  /** Open a canvas, saving what the current one has pending first. */
  visit(canvasId: string, target?: CanvasTarget): Promise<void>
}

const sceneKey: InjectionKey<CanvasScene> = Symbol('canvas-scene')
export function useCanvasScene() {
  const scene = inject(sceneKey)
  if (!scene) throw new Error('No canvas scene is provided')
  return scene
}

export function createCanvasScene(): CanvasScene {
  const router = useRouter()
  // The remaining parts are attached below, in dependency order.
  const scene = {
    ...stores(),
    flow: useVueFlow(),
    surface: ref<HTMLElement>(),
    reducedMotion: useReducedMotion(),
    route: useCanvasRoute(),
    menus: menus(),
  } as unknown as CanvasScene
  const { workspace, session, edits, shell, route } = scene
  provide(sceneKey, scene)

  scene.kind = computed(() =>
    isSystemCanvas(route.canvasId.value) ? route.canvasId.value : 'custom',
  )
  scene.custom = computed(() => scene.kind.value === 'custom')
  scene.canvas = computed(() =>
    workspace.canvases.find((canvas) => canvas.id === route.canvasId.value),
  )
  scene.name = computed(() => workspace.canvasName(route.canvasId.value))

  const settingsDialog = shallowRef<InstanceType<typeof SettingsDialog>>()
  scene.dialogs = {
    settingsDialog,
    settings() {
      shell.closePanels()
      scene.menus.canvas.value = false
      shell.settingsOpen = true
    },
    closeSettings: () => settingsDialog.value?.close(),
    scan(target) {
      shell.scanTarget = target
    },
    addWindows,
    shareCard,
    windowMenu: chooseWindowAction,
  }
  const pruning = usePreferencePruning(() => scene.removalUndo?.preferences())
  scene.removalUndo = useCardRemovalUndo({
    sync: workspace.sync,
    released: (context) => {
      if (isCurrentApi(context)) pruning.pruneCards()
    },
    error: notify.error,
  })
  watch(
    scene.removalUndo.count,
    (count) => {
      shell.pinnedToasts = count
    },
    { immediate: true },
  )

  // State first; the parts below only read one another lazily.
  scene.focus = useCardFocus(scene)
  scene.layout = useCanvasLayout(scene)
  scene.paging = useCanvasPaging(scene)
  scene.morph = useCanvasMorph(scene)
  scene.windows = useCanvasWindows(scene)
  scene.reveal = useWindowReveal(scene)
  scene.cards = useCardActions(scene)
  scene.graph = useCanvasGraph(scene)
  scene.camera = useCanvasCamera(scene)

  scene.visit = async (canvasId, target) => {
    if (!scene.reveal.target(canvasId, false)) scene.reveal.cancel()
    scene.focus.clearContent()
    scene.windows.cancelReveal()
    shell.sidebarOpen = false
    if (canvasId === route.canvasId.value) {
      await scene.focus.close()
      if (!route.request.value && !target) return
    }
    void edits.flushNotes(route.canvasId.value)
    scene.camera.save()
    await route.visit(canvasId, target)
  }

  // Leaving: unsaved layout drafts decide first, then the canvas plays out.
  onScopeDispose(session.onBeforeLeave(scene.layout.leave))
  route.onAborted(scene.morph.cancel)
  onBeforeRouteLeave(() => session.canLeave())
  onBeforeRouteUpdate(async (to, from) => {
    if (to.params.instance !== from.params.instance) return session.canLeave()
    const next = String(to.params.canvas)
    if (next === from.params.canvas) return true
    if (!(await scene.layout.leave())) return false
    // Stop the camera before navigation detaches the graph it is animating.
    scene.camera.halt()
    scene.focus.clearContent()
    scene.windows.cancelReveal()
    if (!scene.reveal.target(next, false)) scene.reveal.cancel()
    if (scene.focus.cardId.value) void edits.flushNotes(String(from.params.canvas))
    await scene.morph.leave(next, route.pendingTarget()?.anchor)
    return true
  })

  // Arriving: every request starts from the canvas itself, then finds its camera.
  let shown = ''
  watch(
    route.request,
    (request) => {
      if (!request) return
      const switched = shown !== request.location.canvas
      shown = request.location.canvas
      scene.camera.halt()
      scene.focus.clearContent()
      scene.windows.cancelReveal()
      scene.focus.reset()
      if (!request.anchor) scene.reveal.cancelJump()
      scene.paging.reset(request.location.view === 'paged')
      if (switched) {
        scene.layout.endGesture()
        scene.windows.forget()
        scene.menus.display.value = scene.menus.canvas.value = scene.menus.create.value = false
        shell.scanTarget = null
        scene.graph.rebuild()
      } else scene.morph.cancel()
      void scene.camera.restore()
    },
    { immediate: true },
  )
  watch(
    () => workspace.resourcesLoaded,
    (loaded) => {
      if (loaded) void scene.camera.restore()
    },
  )
  // A canvas that no longer exists (deleted here or by a peer) gives way to Overview.
  watch(
    () => !!workspace.state && scene.custom.value && !scene.canvas.value,
    (missing) => {
      if (missing)
        void router.replace({
          name: 'canvas',
          params: { instance: route.instanceId.value, canvas: 'overview' },
        })
    },
    { immediate: true },
  )

  // A file a terminal sends is offered next to that terminal's card.
  setDownloadContext((resource) => {
    const canvas = scene.canvas.value
    const anchor = canvas?.nodes.find(
      (node) =>
        isTerminalNode(node) &&
        node.sourceId === resource.sourceId &&
        node.windowId === resource.windowId,
    )
    return canvas && anchor ? { canvasId: canvas.id, anchorId: anchor.id } : undefined
  })
  onScopeDispose(() => setDownloadContext())

  useEventListener(window, 'keydown', (event) => {
    if (event.isComposing || event.keyCode === 229 || shell.modalOpen) return
    const target = event.target instanceof Element ? event.target : undefined
    // ProseMirror consumes Escape; from a maximized note's body it still leaves the note.
    const noteEscape =
      event.key === 'Escape' && !!scene.focus.cardId.value && !!target?.closest('.note-card')
    if (event.defaultPrevented && !noteEscape) return
    if (
      event.key === 'Escape' &&
      event.composedPath().some((item) => item instanceof Element && item.role === 'menu')
    )
      return
    const panelOpen = shell.sidebarOpen || shell.connectionsOpen
    if (scene.layout.editing.value && event.key === 'Escape' && !panelOpen) {
      event.preventDefault()
      void scene.layout.leave()
      return
    }
    if (
      target?.closest('.xterm') ||
      (target?.closest('.note-card input, .note-card [contenteditable="true"]') &&
        !(scene.focus.cardId.value && event.key === 'Escape'))
    )
      return
    if (
      scene.paging.active.value &&
      !scene.focus.terminal.value &&
      !panelOpen &&
      !scene.menus.display.value &&
      !scene.menus.canvas.value &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      !target?.closest('input, textarea, select, button, a, [contenteditable="true"]')
    ) {
      const direction = scene.paging.directions.value.find((item) => item.key === event.key)
      if (direction) {
        event.preventDefault()
        if (!event.repeat) scene.paging.move(direction.direction)
        return
      }
    }
    if (event.key !== 'Escape') return
    if (shell.sidebarOpen) shell.sidebarOpen = false
    else if (scene.focus.terminal.value) void scene.focus.closeTerminal()
    else if (scene.focus.cardId.value) {
      event.preventDefault()
      void scene.focus.closeCard()
    } else shell.connectionsOpen = false
  })

  return scene
}
