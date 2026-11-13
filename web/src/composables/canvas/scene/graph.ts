import { computed, ref, watch } from 'vue'
import type { Node, NodeChange, NodePositionChange } from '@vue-flow/core'
import { useEventListener, useMousePressed, useTimeoutFn } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import { apiRevision } from '../../../api/api'
import { activeInstance } from '../../instances/instances'
import { defaultWindowSize } from '../../../../../shared/window-size'
import { notify } from '../../notify'
import { windowVisualState } from '../../../utils/workspace/canvas-status'
import { windowIsClosed } from '../../../utils/workspace/live-resources'
import { orderedItems } from '../../workspace/sidebar-order'
import { insertNoteContent } from '../../../utils/notes/note-document'
import { noteScrollKey } from '../../notes/note-scroll'
import { liveTerminalMetadata } from '../../terminal/terminal-metadata'
import { cachedTerminalView } from '../../terminal/terminals'
import { terminalIdentityKey } from '../../../utils/terminal/terminal-identity'
import { adjacentCanvas, type CanvasDirection } from '../../../utils/canvas/canvas-jump'
import { cardZoomKey } from '../../../utils/canvas/card-zoom'
import { useOrderTransition } from '../order-transition'
import {
  overviewResources,
  overviewSpaceLayout,
  type OverviewInteraction,
} from '../../../utils/canvas/overview'
import { ringLayout, type RingPin } from '../../../utils/canvas/ring-layout'
import { windowKey } from '../../../stores/workspace'
import {
  isTerminalNode,
  type CanvasNode,
  type FileCanvasNode,
  type FileData,
  type NoteCanvasNode,
  type NoteData,
  type SourceResource,
  type TerminalCanvasNode,
  type TerminalData,
} from '../../../api/types'
import type { CanvasScene } from './scene'

const NOTE_LIMIT = 200_000
const cardTypes = ['terminal', 'note', 'file']
export const isCard = (node: Pick<Node, 'type'>) => cardTypes.includes(node.type || '')
/** A window's card in the node list, whichever canvas reference or system layout drew it. */
export const windowNode = (nodes: readonly Node[], target: OverviewInteraction) =>
  nodes.find(
    (node) =>
      node.type === 'terminal' &&
      node.data.sourceId === target.sourceId &&
      node.data.windowId === target.windowId,
  )

/** The cards of the current canvas as VueFlow nodes, kept in step with shared state. */
export function useCanvasGraph(scene: CanvasScene) {
  const { workspace, edits, view, shell, flow } = scene
  const { t, n, locale } = useI18n()
  const { nodes, setNodes, ariaLiveMessage } = flow
  /** Bumped to remount VueFlow after a maximized card returns to the canvas. */
  const key = ref(0)
  /** The first camera for this canvas has been applied; reorders may animate from here. */
  let presented = false

  /** The window Overview keeps listed although the filter would hide it. */
  const interaction = computed<OverviewInteraction | undefined>(() => {
    if (scene.kind.value !== 'overview') return
    return (
      scene.windows.pendingCreated.value ||
      scene.focus.selected.value ||
      scene.reveal.target('overview') ||
      scene.focus.terminal.value ||
      focusedWindow()
    )
  })
  function focusedWindow() {
    const card = scene.focus.activeElement.value?.closest<HTMLElement>('.terminal-card')
    if (card?.dataset.sourceId && card.dataset.windowId)
      return { sourceId: card.dataset.sourceId, windowId: card.dataset.windowId }
  }
  const visibleOverview = computed(() =>
    overviewResources(
      workspace.resources,
      {
        statuses: view.statuses,
        excluded: view.scope === 'unplaced' ? workspace.placedWindows : undefined,
      },
      view.order,
      interaction.value,
    ),
  )
  const visibleOverviewCount = computed(() =>
    visibleOverview.value.reduce(
      (total, source) =>
        total + source.spaces.reduce((sum, space) => sum + space.windows.length, 0),
      0,
    ),
  )

  function terminalData(node: TerminalCanvasNode, system = !scene.custom.value): TerminalData {
    const found = workspace.resourceFor(node)
    const config = workspace.sources.find((source) => source.id === node.sourceId)
    const canvasId = scene.canvas.value?.id
    const visual = windowVisualState(found.source, found.window, workspace.freshStatuses)
    const closed = windowIsClosed(
      found.source,
      node.windowId,
      liveTerminalMetadata.value.get(windowKey(node)),
    )
    return {
      ...node,
      preferenceKey: config
        ? terminalIdentityKey(activeInstance.value.id, config, node.windowId)
        : '',
      newTab: canvasId
        ? {
            pending: () =>
              scene.windows.creating.has(scene.windows.creationId(node.sourceId, found.spaceId)),
            create: () =>
              scene.windows.createTab(node.sourceId, found.spaceId, {
                canvasId,
                anchor: { ...node },
                focusedId: scene.focus.terminal.value?.id,
              }),
          }
        : undefined,
      canvasJump: {
        neighbor: (direction: CanvasDirection) =>
          adjacentCanvas(
            workspace.windowCanvases(node.sourceId, node.windowId),
            scene.route.canvasId.value,
            direction,
          ),
        go: (direction, focus) => void scene.reveal.jump(node.id, direction, focus),
      },
      status: visual.status,
      statusFresh: visual.fresh,
      name:
        found.window?.name ||
        cachedTerminalView(node.sourceId, node.windowId)?.name ||
        t(closed ? 'app.closedWindow' : 'app.window'),
      subtitle: `${found.source?.name || config?.name || t('app.unknownConnection')} / ${found.space?.name || t('app.space')}`,
      available: !!found.window && !found.source?.error,
      closed,
      sourceOffline: !!found.source?.error,
      panes: found.window?.panes || [],
      overview: system,
      focus: false,
      mobile: shell.mobile,
      onAction: scene.cards.terminalAction,
      onResize: scene.layout.resizeEnd,
      onResizeStart: scene.layout.resizeStart,
    }
  }
  /** Whether a card's reading position may still be stored: same account, card still there. */
  function persists(id: string, type: 'note' | 'file') {
    const { id: instance, base } = activeInstance.value,
      canvasId = scene.route.canvasId.value
    return () =>
      activeInstance.value.id === instance &&
      activeInstance.value.base === base &&
      !!workspace.state?.canvases
        .find((canvas) => canvas.id === canvasId)
        ?.nodes.some((candidate) => candidate.id === id && candidate.type === type)
  }
  function noteData(node: NoteCanvasNode, focus = false): NoteData {
    const canvasId = scene.route.canvasId.value,
      instance = activeInstance.value.id
    return {
      ...node,
      canvasId,
      zoomKey: cardZoomKey(instance, node.id),
      scrollKey: noteScrollKey(instance, canvasId, node.id),
      mobile: shell.mobile,
      focus,
      onResize: scene.layout.resizeEnd,
      onResizeStart: scene.layout.resizeStart,
      canPersistView: persists(node.id, 'note'),
      onAttachment: (value) => {
        const canvas = workspace.canvases.find((canvas) =>
          canvas.nodes.some((item) => item.type === 'note' && item.id === node.id),
        )
        const latest = canvas?.nodes.find(
          (item): item is NoteCanvasNode => item.type === 'note' && item.id === node.id,
        )
        if (!canvas || !latest) return
        const content = insertNoteContent(latest.content, value)
        if (content.length > NOTE_LIMIT) notify.error(t('panels.note.tooLong'))
        else edits.editNote(canvas.id, node.id, { content })
      },
      onChange: (id, patch) => edits.editNote(canvasId, id, patch),
      onFlush: () => void edits.flushNotes(canvasId),
      onAction: scene.cards.cardAction,
    }
  }
  function fileData(node: FileCanvasNode, focus = false): FileData {
    const instanceId = activeInstance.value.id
    return {
      ...node,
      zoomKey: cardZoomKey(instanceId, node.id),
      instanceId,
      canvasId: scene.route.canvasId.value,
      mobile: shell.mobile,
      focus,
      onResize: scene.layout.resizeEnd,
      onResizeStart: scene.layout.resizeStart,
      onRemove: (id) => void scene.cards.remove(id),
      onAction: scene.cards.cardAction,
      canPersistView: persists(node.id, 'file'),
    }
  }

  function cardNode(node: CanvasNode, data: object, system = false): Node {
    const editing = scene.layout.editing.value
    return {
      id: node.id,
      type: node.type,
      position: { x: node.x, y: node.y },
      data,
      style: { width: `${node.width}px`, height: `${node.height}px` },
      draggable: !system && (!shell.mobile || editing),
      selectable: !shell.mobile,
      dragHandle: editing ? '.card-layout-mask' : '.drag-handle',
    }
  }
  function terminalNode(node: TerminalCanvasNode, system = false): Node {
    node = { ...node, ...workspace.windowSize(node), ...scene.layout.geometry(node.id) }
    return cardNode(node, terminalData(node, system), system)
  }
  function canvasNode(node: CanvasNode): Node {
    if (isTerminalNode(node)) return terminalNode(node)
    node = { ...node, ...scene.layout.geometry(node.id) }
    return cardNode(node, node.type === 'file' ? fileData(node) : noteData(node))
  }

  function createNode(
    source: SourceResource,
    spaceId: string | undefined,
    bounds: { x: number; y: number; width: number; height: number },
  ): Node {
    const id = scene.windows.creationId(source.id, spaceId)
    return {
      id,
      type: 'create',
      position: { x: bounds.x, y: bounds.y },
      draggable: false,
      selectable: false,
      style: { width: `${bounds.width}px`, height: `${bounds.height}px` },
      data: {
        sourceId: source.id,
        spaceId,
        width: bounds.width,
        height: bounds.height,
        context: [source.name, source.spaces.find((space) => space.id === spaceId)?.name]
          .filter(Boolean)
          .join(' / '),
        available: !source.error && !['offline', 'error', 'disconnected'].includes(source.status),
        pending: () => scene.windows.creating.has(id),
        create: () =>
          spaceId
            ? scene.windows.createTab(source.id, spaceId)
            : scene.windows.createSpace(source.id),
      },
    }
  }
  /** Overview: every connection as a group, its spaces as rows of window cards. */
  function overviewNodes(): Node[] {
    const result: Node[] = []
    const creation = view.showsCreation
    let y = 0
    for (const config of orderedItems(workspace.sources, workspace.sidebarOrder.sources)) {
      const source = workspace.resources.find((item) => item.id === config.id)
      if (!source) continue
      const visible = visibleOverview.value.find((item) => item.id === config.id)
      const rows = source.spaces.flatMap((space) => {
        const windows = visible?.spaces.find((item) => item.id === space.id)?.windows || []
        if (!windows.length && !creation) return []
        const layout = overviewSpaceLayout(
          windows.map((window) =>
            workspace.windowSize({ sourceId: source.id, windowId: window.id }),
          ),
          view.perRow,
          creation,
          defaultWindowSize,
          { x: 24, y: 34 },
        )
        return [{ space: { ...space, windows }, layout, height: 54 + layout.height }]
      })
      if (!rows.length && !creation) continue
      const width = Math.max(
        defaultWindowSize.width + 48,
        ...rows.map((row) => 48 + row.layout.width),
      )
      const height = (creation ? 132 : 78) + rows.reduce((sum, row) => sum + row.height, 0)
      result.push({
        id: `source:${source.id}`,
        type: 'group',
        position: { x: 0, y },
        data: {
          kind: 'source',
          name: config.name,
          subtitle: config.transport === 'local' ? t('app.local') : 'SSH',
          count: rows.reduce((sum, row) => sum + row.space.windows.length, 0),
          width,
          height,
        },
        draggable: false,
        selectable: false,
        style: { width: `${width}px`, height: `${height}px`, zIndex: '-1', pointerEvents: 'none' },
      })
      let rowY = y + 68
      for (const { space, height: rowHeight, layout } of rows) {
        result.push({
          id: `space:${source.id}:${space.id}`,
          type: 'group',
          position: { x: 24, y: rowY },
          data: { kind: 'space', name: space.name, count: space.windows.length },
          draggable: false,
          selectable: false,
          style: { width: `${width - 48}px`, pointerEvents: 'none' },
        })
        space.windows.forEach((window, index) => {
          const card = layout.cards[index]!
          result.push(
            terminalNode(
              {
                type: 'terminal',
                id: `window:${source.id}:${space.id}:${window.id}`,
                sourceId: source.id,
                windowId: window.id,
                spaceId: space.id,
                ...card,
                y: rowY + card.y,
              },
              true,
            ),
          )
        })
        const create = layout.cards[space.windows.length]
        if (create) result.push(createNode(source, space.id, { ...create, y: rowY + create.y }))
        rowY += rowHeight
      }
      if (creation)
        result.push(
          createNode(source, undefined, { x: 24, y: rowY + 4, width: width - 48, height: 32 }),
        )
      y += height + 48
    }
    return result
  }

  /** The working set keeps the window on screen in place while the rest of the ring re-forms. */
  let ringPin: RingPin | undefined
  function pinRing(node: Node | undefined) {
    ringPin = node && {
      id: node.id,
      x: node.position.x + node.data.width / 2,
      y: node.position.y + node.data.height / 2,
    }
  }
  /** Working set: recently used windows around a ring, most recent first. */
  function workingSetNodes(): Node[] {
    const windows = new Map<string, Omit<TerminalCanvasNode, 'x' | 'y'>>()
    for (const agent of workspace.workingSetEntries) {
      const id = `working:${windowKey(agent)}`
      if (windows.has(id)) continue
      const { spaceId } = workspace.resourceFor({ ...agent, spaceId: '' })
      windows.set(id, {
        type: 'terminal',
        id,
        ...workspace.windowSize(agent),
        spaceId,
        sourceId: agent.sourceId,
        windowId: agent.windowId,
      })
    }
    const cards = [...windows.values()]
    return ringLayout(cards, ringPin).map((placed, index) =>
      terminalNode({ ...cards[index]!, x: placed.x, y: placed.y }, true),
    )
  }

  // VueFlow has no locale API; its public attributes and live-message state
  // let Canvas describe the existing keyboard behavior without replacing it.
  function accessible<T extends Node>(node: T): T {
    const card = isCard(node)
    return {
      ...node,
      domAttributes: {
        ...node.domAttributes,
        'aria-roledescription': card ? t('app.card') : undefined,
        'aria-describedby':
          card && node.selectable !== false
            ? node.draggable
              ? 'canvas-card-move-help'
              : 'canvas-card-select-help'
            : undefined,
      },
    }
  }
  function announceMove(changes: NodeChange[]) {
    const active = document.activeElement
    if (
      !(active instanceof HTMLElement) ||
      !scene.surface.value?.contains(active) ||
      !active.matches('.vue-flow__node, .vue-flow__nodesselection-rect')
    )
      return
    const moved = changes.filter(
      (change): change is NodePositionChange =>
        change.type === 'position' &&
        change.dragging === false &&
        !!change.position &&
        !!change.from &&
        (change.position.x !== change.from.x || change.position.y !== change.from.y),
    )
    const change = active.matches('.vue-flow__nodesselection-rect')
      ? moved[0]
      : moved.find((item) => item.id === active.dataset.id)
    if (!change) return
    if (moved.length > 1) {
      ariaLiveMessage.value = t('app.cardsMoved', moved.length)
      return
    }
    const node = nodes.value.find((item) => item.id === change.id)
    ariaLiveMessage.value = t('app.cardMoved', {
      name:
        node?.type === 'terminal'
          ? node.data.name
          : node?.type === 'note'
            ? node.data.title || t('app.note')
            : node?.data.asset?.filename || t('app.card'),
      x: n(Math.round(change.position.x)),
      y: n(Math.round(change.position.y)),
    })
  }

  function commit(next: Node[]) {
    const previous = new Map(
      nodes.value.map((node) => [node.id, node as Node & { selected?: boolean }]),
    )
    setNodes(
      next.map((node) =>
        accessible({
          ...node,
          selected: previous.get(node.id)?.selected,
          ...(scene.morph.anchors(node) ? { class: 'canvas-morph-anchor' } : {}),
        }),
      ),
    )
  }
  /** New card data on the nodes already laid out; their geometry does not change. */
  function refreshData(next: Node[]) {
    const updated = new Map(next.map((node) => [node.id, node.data]))
    setNodes(
      nodes.value.map((node) => ({
        ...node,
        data: updated.has(node.id)
          ? { ...updated.get(node.id), width: node.data.width, height: node.data.height }
          : node.data,
      })),
    )
  }
  const customNodes = () => (scene.canvas.value?.nodes || []).map(canvasNode)

  // Overview reorders wait for a quiet moment and then animate; nothing else does.
  const { pressed: pointerDown } = useMousePressed({ target: scene.surface, capture: true })
  const { isPending: settling, start: settle } = useTimeoutFn(() => {}, 200, { immediate: false })
  // Keep a short quiet period through wheel tails and toolbar zoom animations.
  useEventListener(scene.surface, ['wheel', 'pointerup', 'keyup'], () => settle(), {
    passive: true,
    capture: true,
  })
  const overviewMotion = useOrderTransition<Node>({
    current: () => nodes.value,
    target: overviewNodes,
    commit,
    refresh: refreshData,
    enabled: () => scene.kind.value === 'overview' && workspace.resourcesLoaded,
    active: () =>
      scene.kind.value === 'overview' &&
      workspace.pageVisible &&
      !scene.focus.maximized.value &&
      !scene.route.request.value &&
      presented,
    blocked: () =>
      pointerDown.value ||
      settling.value ||
      !!scene.focus.activeElement.value?.closest('.card-content'),
    scope: () => `${apiRevision.value}/${scene.route.canvasId.value}`,
    reduced: () => scene.reducedMotion.value,
    host: () => scene.surface.value,
    settled: async (manual) => {
      if (scene.focus.maximized.value || scene.route.request.value) return
      if (scene.paging.active.value) await scene.paging.fit()
      else if (manual && nodes.value.length) await scene.camera.fitAll(0)
    },
  })

  const layouts = { overview: overviewNodes, 'working-set': workingSetNodes, custom: customNodes }
  /** Lay the canvas out again. `order`/`manual` say why Overview's geometry changed. */
  function rebuild(change: 'auto' | 'order' | 'manual' = 'auto') {
    if (!workspace.resourcesLoaded) return
    if (scene.kind.value === 'overview') overviewMotion.request(change)
    else commit(layouts[scene.kind.value]())
  }
  /** New status, names and other card data; the layout stays as it is. */
  function refresh() {
    if (!workspace.resourcesLoaded) return
    if (scene.kind.value === 'overview') overviewMotion.request('auto')
    else refreshData(layouts[scene.kind.value]())
  }

  // Discovery: new or removed windows change the layout; anything else only refreshes data.
  let resourceSignature = '',
    layoutSignature = ''
  watch(
    () => workspace.resources,
    (next) => {
      const signature = JSON.stringify(next)
      if (signature === resourceSignature) return
      resourceSignature = signature
      const layout = JSON.stringify(
        next.map((source) => {
          const config = workspace.sources.find((item) => item.id === source.id)
          return [
            source.id,
            config?.transport,
            config?.target,
            source.spaces.map((space) => [space.id, space.windows.map((window) => window.id)]),
          ]
        }),
      )
      const changed = layout !== layoutSignature
      layoutSignature = layout
      if (scene.layout.gesturing()) return
      if (scene.kind.value === 'overview') rebuild(changed ? 'order' : 'auto')
      else if (changed) rebuild()
      else refresh()
    },
  )
  // Shared state: rebuild only when this canvas's cards or the window sizes changed.
  let stateSignature = ''
  const stateShape = () =>
    JSON.stringify([scene.canvas.value?.nodes, workspace.windowSizes, workspace.sources])
  workspace.onApplied(({ sourcesChanged }) => {
    if (sourcesChanged) resourceSignature = layoutSignature = ''
    const signature = stateShape()
    if (signature === stateSignature || scene.layout.gesturing()) return
    stateSignature = signature
    rebuild()
  })
  // The working set's members and order follow reads, not discovery.
  watch(
    () => workspace.workingSetEntries.map(windowKey).join(),
    () => {
      if (scene.kind.value === 'working-set') rebuild()
    },
  )
  edits.onNoteChanged((id) => {
    const note = scene.canvas.value?.nodes.find(
      (item): item is NoteCanvasNode => item.id === id && item.type === 'note',
    )
    if (!note) return
    setNodes(
      nodes.value.map((node) =>
        node.id === id
          ? {
              ...node,
              data: { ...node.data, ...note },
              style: { ...node.style, height: `${note.height}px` },
            }
          : node,
      ),
    )
  })
  watch(interaction, (value) => {
    scene.windows.remember(value)
    if (scene.kind.value === 'overview') rebuild()
  })
  watch(
    () => [view.statuses, view.scope, view.order, view.perRow],
    () => {
      if (scene.kind.value === 'overview') rebuild('manual')
    },
  )
  watch(() => workspace.freshStatuses, refresh)
  watch(locale, () => {
    ariaLiveMessage.value = ''
    if (workspace.resourcesLoaded) commit(layouts[scene.kind.value]())
  })
  watch(
    () => workspace.resourcesLoaded,
    (loaded) => {
      if (loaded) rebuild()
    },
  )
  watch(
    () => shell.mobile,
    () => {
      if (!scene.layout.editing.value) rebuild()
    },
  )

  return {
    key,
    nodes,
    interaction,
    visibleOverviewCount,
    terminalData,
    noteData,
    fileData,
    rebuild,
    refresh,
    announceMove,
    pinRing,
    remount: () => key.value++,
    /** Reorders animate only once this canvas has been shown at its first camera. */
    setPresented(value: boolean) {
      presented = value
    },
    presented: () => presented,
    /** A terminal card as the plain canvas node it stands for. */
    terminalOf(id: string): TerminalCanvasNode | undefined {
      const node = nodes.value.find((item) => item.id === id)
      return node?.type === 'terminal'
        ? {
            type: 'terminal',
            id,
            sourceId: node.data.sourceId,
            spaceId: node.data.spaceId,
            windowId: node.data.windowId,
            x: node.position.x,
            y: node.position.y,
            width: node.data.width,
            height: node.data.height,
          }
        : undefined
    },
  }
}
export type CanvasGraph = ReturnType<typeof useCanvasGraph>
