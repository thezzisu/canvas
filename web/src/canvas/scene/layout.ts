import { computed, onScopeDispose, provide, ref, shallowRef, watch } from 'vue'
import type { Node, NodeChange } from '@vue-flow/core'
import { useI18n } from 'vue-i18n'
import { api, apiContext, isCurrentApi, requireCurrentApi, segment, ApiError } from '../../api/api'
import { inputMode } from '../../lib/mobile-layout'
import {
  resizeFromDelta,
  snapCardPosition,
  snapCardResize,
  type CardBounds,
} from '../card-alignment'
import { LayoutDraft } from '../layout-draft'
import { layoutEditingKey } from '../layout-editing'
import { windowKey } from '../../stores/workspace'
import { isTerminalNode } from '../../api/types'
import { isCard } from './graph'
import type { CanvasScene } from './scene'

const cardBounds = (node: Node): CardBounds => ({
  id: node.id,
  ...node.position,
  width: node.data.width,
  height: node.data.height,
})
const minimumSize = (node?: Node) =>
  node?.type === 'terminal' ? { width: 360, height: 220 } : { width: 240, height: 160 }

/**
 * Moving and resizing cards on a custom canvas. With a pointer each gesture saves by
 * itself; on touch the layout is edited as a draft that is applied or discarded whole.
 */
export function useCanvasLayout(scene: CanvasScene) {
  const { workspace, edits, shell, flow } = scene
  const { t } = useI18n()
  const { nodes, applyNodeChanges, getViewport } = flow
  const draft = shallowRef<LayoutDraft>()
  const editing = computed(() => !!draft.value)
  const busy = ref(false),
    selected = ref(''),
    error = ref('')
  /** The unsaved-draft prompt, while a navigation waits for its answer. */
  const exitOpen = ref(false)
  let resolveExit: ((leave: boolean) => void) | undefined
  let exit: Promise<boolean> | undefined
  /** The canvas a drag or resize is in progress on; shared updates wait for it to end. */
  let gesture = ''
  let before: CardBounds[] | undefined
  let resizing:
    { origin: CardBounds; rawOrigin: CardBounds; raw: CardBounds; snapped: CardBounds } | undefined
  const locked = () => shell.mobile && !editing.value
  const snaps = () => !!scene.canvas.value?.snapToGrid

  onScopeDispose(edits.guardDraft(() => !!draft.value?.changes.size))
  // A prompt still open when the view goes away is answered: stay.
  onScopeDispose(() => resolveExit?.(false))

  function endGesture() {
    before = undefined
    gesture = ''
    resizing = undefined
  }
  function dragStart(event?: { node: Node }) {
    if (locked()) return
    gesture = scene.route.canvasId.value
    if (!draft.value) return
    before = nodes.value.map(cardBounds)
    for (const { id, ...geometry } of before) draft.value.capture(id, geometry)
    if (event?.node) selected.value = event.node.id
  }
  /** A cancelled touch puts every card back where the gesture found it. */
  function cancelGesture() {
    if (!editing.value || !before) return
    for (const rect of before) {
      const node = nodes.value.find((node) => node.id === rect.id)
      if (!node) continue
      node.position = { x: rect.x, y: rect.y }
      node.data.width = rect.width
      node.data.height = rect.height
      node.style = { ...node.style, width: `${rect.width}px`, height: `${rect.height}px` }
    }
    endGesture()
  }
  function snapDrag(event: { node: Node; nodes?: Node[] }) {
    if (locked() || !scene.custom.value || !snaps()) return
    const moving = event.nodes?.length ? event.nodes : [event.node]
    const ids = new Set(moving.map((node) => node.id))
    const rects = moving.map(cardBounds)
    const x = Math.min(...rects.map((rect) => rect.x)),
      y = Math.min(...rects.map((rect) => rect.y))
    const group = {
      id: event.node.id,
      x,
      y,
      width: Math.max(...rects.map((rect) => rect.x + rect.width)) - x,
      height: Math.max(...rects.map((rect) => rect.y + rect.height)) - y,
    }
    const peers = nodes.value.filter((node) => !ids.has(node.id) && isCard(node)).map(cardBounds)
    const position = snapCardPosition(group, peers, getViewport().zoom)
    for (const node of moving)
      node.position = { x: node.position.x + position.x - x, y: node.position.y + position.y - y }
  }
  function store(id: string, patch: Partial<Omit<CardBounds, 'id'>>) {
    if (draft.value) draft.value.update(id, patch)
    else if (scene.canvas.value) edits.editLayout(scene.canvas.value.id, id, patch)
  }
  function dragStop(event: { node: Node; nodes?: Node[]; event?: Event }) {
    if (locked()) return
    if (editing.value && (!before || event.event?.type === 'touchcancel')) {
      cancelGesture()
      return
    }
    snapDrag(event)
    for (const node of event.nodes?.length ? event.nodes : [event.node])
      store(node.id, { x: node.position.x, y: node.position.y })
    endGesture()
    scene.graph.rebuild()
  }
  function resizeStart(id: string, bounds: Omit<CardBounds, 'id'>) {
    dragStart()
    const node = nodes.value.find((node) => node.id === id)
    const origin = node && cardBounds(node)
    resizing = origin && {
      origin,
      rawOrigin: { id, ...bounds },
      raw: { id, ...bounds },
      snapped: origin,
    }
  }
  function resizeEnd(id: string, width: number, height: number, x?: number, y?: number) {
    if (locked() || (editing.value && !before)) return
    const node = scene.canvas.value?.nodes.find((item) => item.id === id)
    if (resizing?.origin.id === id) ({ width, height, x, y } = resizing.snapped)
    endGesture()
    if (node) {
      const size = { width, height: Math.max(160, Math.min(3000, height)) }
      if (!draft.value && isTerminalNode(node)) workspace.windowSizes[windowKey(node)] = size
      store(id, { ...size, ...(x === undefined ? {} : { x }), ...(y === undefined ? {} : { y }) })
    }
    scene.graph.rebuild()
  }
  /** VueFlow's node changes, with a resize in progress snapped to its neighbours. */
  function change(changes: NodeChange[]) {
    if (resizing) {
      const { origin, rawOrigin } = resizing
      const dimensions = changes.find(
        (change) =>
          change.type === 'dimensions' &&
          change.id === origin.id &&
          change.resizing &&
          change.dimensions,
      )
      if (dimensions?.type === 'dimensions' && dimensions.dimensions) {
        const position = changes.find(
          (change) => change.type === 'position' && change.id === origin.id,
        )
        const raw = (resizing.raw = {
          ...resizing.raw,
          ...dimensions.dimensions,
          ...(position?.type === 'position' ? position.position : {}),
        })
        const current = resizeFromDelta(origin, rawOrigin, raw)
        const rect = (resizing.snapped = snaps()
          ? snapCardResize(
              origin,
              current,
              nodes.value.map(cardBounds),
              getViewport().zoom,
              minimumSize(nodes.value.find((node) => node.id === origin.id)),
            )
          : current)
        changes = changes
          .filter((change) => !(change.type === 'position' && change.id === origin.id))
          .map((change) =>
            change === dimensions
              ? { ...dimensions, dimensions: { width: rect.width, height: rect.height } }
              : change,
          )
        changes.push({
          id: origin.id,
          type: 'position',
          from: origin,
          position: { x: rect.x, y: rect.y },
        })
      }
    }
    applyNodeChanges(changes)
    if (editing.value)
      for (const change of changes)
        if (change.type === 'dimensions' && change.dimensions && change.resizing) {
          const node = nodes.value.find((node) => node.id === change.id)
          if (node) Object.assign(node.data, change.dimensions)
        }
    scene.graph.announceMove(changes)
  }

  /** Touch: stage every move and resize until the whole layout is applied. */
  async function start() {
    scene.menus.canvas.value = false
    const eligible = () => shell.mobile && scene.custom.value && !!scene.canvas.value
    if (!eligible() || busy.value) return
    const canvasId = scene.route.canvasId.value,
      context = apiContext()
    if (
      !(await edits.flushAll()) ||
      !isCurrentApi(context) ||
      scene.route.canvasId.value !== canvasId ||
      !eligible()
    )
      return
    scene.focus.clearContent()
    selected.value = ''
    error.value = ''
    draft.value = new LayoutDraft(canvasId, nodes.value.map(cardBounds))
    scene.graph.rebuild()
  }
  function discard() {
    if (busy.value) return
    draft.value = undefined
    selected.value = ''
    error.value = ''
    endGesture()
    scene.graph.rebuild()
  }
  async function apply(): Promise<boolean> {
    const staged = draft.value
    if (!staged || busy.value) return !staged
    if (!staged.changes.size) {
      discard()
      return true
    }
    busy.value = true
    error.value = ''
    const context = apiContext()
    try {
      await api(
        `/api/canvases/${segment(staged.canvasId)}/layout`,
        { method: 'PATCH', body: JSON.stringify({ nodes: [...staged.changes.values()] }) },
        context,
      )
      await workspace.sync()
      requireCurrentApi(context)
      busy.value = false
      discard()
      return true
    } catch (reason) {
      if (isCurrentApi(context)) {
        // Keep the draft after an ambiguous network failure; idempotent expectations allow a safe retry.
        await workspace.sync().catch(() => {})
        error.value =
          reason instanceof ApiError && reason.status === 409
            ? t('app.layoutConflict')
            : t('app.layoutFailed')
      }
      return false
    } finally {
      busy.value = false
    }
  }
  /** Before anything that would lose the draft: resolves true once it is safe to go on. */
  function leave(): Promise<boolean> {
    if (!draft.value) return Promise.resolve(true)
    if (busy.value) return Promise.resolve(false)
    if (!draft.value.changes.size) {
      discard()
      return Promise.resolve(true)
    }
    if (exit) return exit
    exitOpen.value = true
    exit = new Promise<boolean>((resolve) => {
      resolveExit = resolve
    }).finally(() => {
      exit = undefined
      resolveExit = undefined
      exitOpen.value = false
    })
    return exit
  }
  async function chooseExit(action: 'apply' | 'discard' | 'stay') {
    if (action === 'apply' && !(await apply())) return
    if (action === 'discard') discard()
    resolveExit?.(action !== 'stay')
  }

  // Switching to keyboard input ends touch editing; the switch waits for the draft's fate.
  let restoringMode = false
  function setMode(value: typeof inputMode.value) {
    restoringMode = true
    inputMode.value = value
    restoringMode = false
  }
  watch(
    inputMode,
    (value, previous) => {
      if (!editing.value || restoringMode || value === previous) return
      setMode(previous)
      void leave().then((allowed) => {
        if (allowed) setMode(value)
      })
    },
    { flush: 'sync' },
  )
  watch(
    () => shell.mobile,
    (mobile) => {
      if (mobile || !editing.value || restoringMode) return
      const preference = inputMode.value
      setMode('touch')
      void leave().then((allowed) => {
        if (allowed) setMode(preference)
      })
    },
    { flush: 'sync' },
  )

  provide(layoutEditingKey, { active: editing, busy, selected, start: resizeStart, end: resizeEnd })

  return {
    editing,
    busy,
    selected,
    error,
    exitOpen,
    geometry: (id: string) => draft.value?.geometry(id),
    gesturing: () => !!gesture,
    dragStart,
    snapDrag,
    dragStop,
    resizeStart,
    resizeEnd,
    change,
    cancelGesture,
    start,
    discard,
    apply,
    leave,
    chooseExit,
    /** A canvas switch abandons any gesture in progress. */
    endGesture,
  }
}
export type CanvasLayout = ReturnType<typeof useCanvasLayout>
