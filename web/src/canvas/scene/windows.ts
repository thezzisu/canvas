import { nextTick, reactive, shallowRef } from 'vue'
import { useEventListener } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import { segment, uuid, write } from '../../api/api'
import { notify } from '../../lib/notify'
import { focusWindow } from '../../terminal/terminals'
import { confirmAction } from '../../workspace/dialogs'
import { pageViewport } from '../overview-paging'
import type { OverviewInteraction } from '../overview'
import type { Canvas, SourceResource, TerminalCanvasNode } from '../../api/types'
import type { CanvasScene } from './scene'

/** Where a new tab's card goes when it is created from a card on a custom canvas. */
export interface TabDestination {
  canvasId: string
  anchor: TerminalCanvasNode
  /** The maximized window the tab was created from; the new tab takes its place. */
  focusedId?: string
  /** The native result, kept so retrying a failed canvas write cannot create another tab. */
  created?: TerminalCanvasNode
}
type CreatedWindow = { canvasId: string; sourceId: string; spaceId: string; windowId: string }
const FOCUS_ATTEMPTS = 30
const sourcePath = (sourceId: string) => `/api/sources/${segment(sourceId)}`

/** Native spaces and windows: creating them, and bringing a new one into view. */
export function useCanvasWindows(scene: CanvasScene) {
  const { workspace, shell, flow } = scene
  const { t } = useI18n()
  const { nodes, setNodes, setViewport } = flow
  /** Creations in flight, by `creationId`; their controls show progress and ignore repeats. */
  const creating = reactive(new Set<string>())
  /** The window just created here, until it has been shown and focused. */
  const pendingCreated = shallowRef<CreatedWindow>()
  let cameraReady = false
  let intent = 0
  /** The last window used in Overview; a new space is created beside its space. */
  let lastInteraction: OverviewInteraction | undefined

  const creationId = (sourceId: string, spaceId?: string) =>
    spaceId ? `create-tab:${sourceId}:${spaceId}` : `create-space:${sourceId}`
  function cancelReveal() {
    intent++
    pendingCreated.value = undefined
  }
  function remember(interaction: OverviewInteraction | undefined) {
    if (interaction) lastInteraction = interaction
  }

  /** Create a space (no `spaceId`) or a tab, then show and focus it if the user is still here. */
  async function create(
    sourceId: string,
    spaceId?: string,
    name?: string,
    destination?: TabDestination,
  ) {
    const id = creationId(sourceId, spaceId)
    if (creating.has(id)) return
    creating.add(id)
    cancelReveal()
    const started = intent
    const origin = destination?.canvasId || scene.route.canvasId.value,
      pageBefore = scene.paging.current.value?.id
    const context = scene.graph.interaction.value || lastInteraction
    const reference =
      context?.sourceId === sourceId
        ? context.windowId
        : nodes.value.find(
            (node) =>
              `${node.data.sourceId}/${node.data.windowId}` === pageBefore &&
              node.data.sourceId === sourceId,
          )?.data.windowId
    const sourceSpaceId =
      reference && workspace.resourceFor({ sourceId, spaceId: '', windowId: reference }).spaceId
    try {
      const created =
        destination?.created ||
        (await write<{ spaceId: string; windowId: string }>(
          `${sourcePath(sourceId)}/spaces${spaceId ? `/${segment(spaceId)}/windows` : ''}`,
          'POST',
          {
            ...(name?.trim() ? { name: name.trim() } : {}),
            ...(!spaceId && sourceSpaceId ? { sourceSpaceId } : {}),
          },
        ))
      if (destination) {
        destination.created ||= {
          type: 'terminal',
          id: uuid(),
          sourceId,
          spaceId: created.spaceId,
          windowId: created.windowId,
          ...freeSlot(origin, destination.anchor),
        }
        await write(`/api/canvases/${segment(origin)}/nodes`, 'POST', {
          nodes: [destination.created],
        })
        await workspace.sync()
      }
      const target = { canvasId: origin, sourceId, ...created }
      const wanted = () =>
        started === intent &&
        origin === scene.route.canvasId.value &&
        (destination
          ? scene.focus.terminal.value?.id === destination.focusedId
          : origin === 'overview' &&
            scene.paging.current.value?.id === pageBefore &&
            !scene.focus.terminal.value)
      if (wanted()) {
        cameraReady = false
        pendingCreated.value = target
      }
      await workspace.refresh()
      if (!wanted() || pendingCreated.value !== target) return
      scene.graph.rebuild()
      if (destination?.focusedId && destination.created)
        scene.focus.terminal.value = destination.created
      await nextTick()
      const page = scene.paging.pages.value.find(
        (page) => page.id === `${sourceId}/${created.windowId}`,
      )
      const frame = scene.paging.frame()
      if (!scene.focus.terminal.value && page && frame) {
        if (!scene.custom.value) scene.paging.select(page)
        if (scene.paging.active.value) await scene.paging.fit(true)
        else
          void setViewport(pageViewport(page, frame), {
            duration: scene.reducedMotion.value ? 0 : 200,
            interpolate: 'linear',
          })
      }
      cameraReady = true
      focusCreated()
    } finally {
      creating.delete(id)
    }
  }
  /** The first gap to the right of the anchor card, on its row. */
  function freeSlot(canvasId: string, anchor: TerminalCanvasNode) {
    let x = anchor.x + anchor.width + 24
    const occupied = workspace.canvases.find((canvas) => canvas.id === canvasId)?.nodes || []
    for (const node of [...occupied].sort((a, b) => a.x - b.x))
      if (
        node.y < anchor.y + anchor.height &&
        node.y + node.height > anchor.y &&
        node.x < x + anchor.width + 24 &&
        node.x + node.width + 24 > x
      )
        x = node.x + node.width + 24
    return { x, y: anchor.y, width: anchor.width, height: anchor.height }
  }
  function createSpace(sourceId: string) {
    void create(sourceId).catch(notify.error)
  }
  /** Ask for an optional name, then create a tab in the space. */
  function createTab(sourceId: string, spaceId: string, destination?: TabDestination) {
    if (creating.has(creationId(sourceId, spaceId))) return
    const source = workspace.resources.find((item) => item.id === sourceId)
    void confirmAction({
      title: t('app.newTab'),
      description: [source?.name, source?.spaces.find((space) => space.id === spaceId)?.name]
        .filter(Boolean)
        .join(' / '),
      label: t('app.name'),
      optional: true,
      button: t('app.newTab'),
      submit: (name) => create(sourceId, spaceId, name, destination),
    })
  }
  function editSpace(source: SourceResource, spaceId: string, operation: 'rename' | 'close') {
    const space = source.spaces.find((item) => item.id === spaceId)
    const rename = operation === 'rename'
    void confirmAction({
      title: t(rename ? 'app.renameSpace' : 'app.closeSpace'),
      description: rename
        ? source.name
        : t('app.closeSpaceDescription', { name: space?.name || '' }),
      label: rename ? t('app.name') : undefined,
      value: rename ? space?.name : undefined,
      danger: !rename,
      button: t(rename ? 'app.renameSpace' : 'app.closeSpace'),
      submit: async (name) => {
        await write(
          `${sourcePath(source.id)}/spaces/${segment(spaceId)}`,
          rename ? 'PATCH' : 'DELETE',
          rename ? { name } : undefined,
        )
        await workspace.refresh()
      },
    })
  }
  function editWindow(
    node: Pick<TerminalCanvasNode, 'sourceId' | 'spaceId' | 'windowId'>,
    operation: 'rename' | 'close',
  ) {
    const { source, space, window } = workspace.resourceFor(node)
    const rename = operation === 'rename'
    void confirmAction({
      title: t(rename ? 'app.renameWindow' : 'app.closeWindow'),
      description: rename
        ? `${source?.name || ''} / ${space?.name || ''}`
        : t('app.closeWindowDescription', { name: window?.name || '' }),
      label: rename ? t('app.windowName') : undefined,
      value: rename ? window?.name : undefined,
      danger: !rename,
      button: t(rename ? 'app.renameWindow' : 'app.closeWindow'),
      submit: async (name) => {
        await write(
          `${sourcePath(node.sourceId)}/spaces/${segment(node.spaceId)}/windows/${segment(node.windowId)}`,
          rename ? 'PATCH' : 'DELETE',
          rename ? { name } : undefined,
        )
        await workspace.refresh()
      },
    })
  }

  /** Focus the created window once its card has its native size and is on screen. */
  function focusCreated(attempt = 0, target = pendingCreated.value) {
    if (
      !target ||
      target !== pendingCreated.value ||
      target.canvasId !== scene.route.canvasId.value ||
      !cameraReady
    )
      return
    const retry = () => {
      if (attempt < FOCUS_ATTEMPTS) requestAnimationFrame(() => focusCreated(attempt + 1, target))
    }
    if (shell.modalOpen) return retry()
    const focused = scene.focus.terminal.value
    if (focused?.sourceId !== target.sourceId || focused.windowId !== target.windowId) {
      const page = scene.paging.pages.value.find(
        (page) => page.id === `${target.sourceId}/${target.windowId}`,
      )
      if (!page || Math.abs(page.height - workspace.windowSize(target).height) > 0.02)
        return retry()
      const frame = scene.paging.frame()
      if (!scene.paging.active.value && frame) void setViewport(pageViewport(page, frame))
    }
    const card = document.querySelector<HTMLElement>(
      `[data-source-id="${target.sourceId}"][data-window-id="${target.windowId}"].terminal-card`,
    )
    if (
      !card?.checkVisibility() ||
      !(shell.mobile || focusWindow(target.sourceId, target.spaceId, target.windowId))
    )
      return retry()
    if (shell.mobile) card.focus({ preventScroll: true })
    void nextTick().then(() => {
      if (pendingCreated.value !== target) return
      if (card.contains(document.activeElement)) pendingCreated.value = undefined
      else retry()
    })
  }
  function focusNewNote(attempt = 0) {
    const id = scene.focus.pending.note
    if (!id) return
    if (!scene.canvas.value?.nodes.some((node) => node.id === id)) {
      scene.focus.pending.note = ''
      return
    }
    const editor = document.querySelector<HTMLTextAreaElement>(`[data-note-id="${id}"] textarea`)
    if (editor?.checkVisibility()) {
      editor.focus()
      if (document.activeElement === editor) {
        scene.focus.pending.note = ''
        return
      }
    }
    if (attempt < FOCUS_ATTEMPTS) requestAnimationFrame(() => focusNewNote(attempt + 1))
  }
  /** Add a note at the centre of the view and start typing in it. */
  async function addNote() {
    if (!(await scene.layout.leave())) return
    const canvas = scene.canvas.value
    if (!canvas || creating.has('note')) return
    creating.add('note')
    const viewport = flow.getViewport(),
      frame = scene.paging.frame() || { width: 800, height: 600 }
    try {
      const previous = new Set(canvas.nodes.map((node) => node.id))
      const result = await write<Canvas>(`/api/canvases/${segment(canvas.id)}/notes`, 'POST', {
        x: Math.round((frame.width / 2 - viewport.x) / viewport.zoom - 160),
        y: Math.round((frame.height / 2 - viewport.y) / viewport.zoom - 120),
        title: t('panels.note.name'),
      })
      await workspace.sync()
      const added = result.nodes.find((node) => !previous.has(node.id))
      if (!added || scene.route.canvasId.value !== canvas.id) return
      if (shell.mobile) {
        scene.focus.maximizeCard(added.id)
        return
      }
      scene.focus.pending.note = added.id
      await nextTick()
      setNodes(nodes.value.map((node) => ({ ...node, selected: node.id === added.id })))
      await nextTick()
      requestAnimationFrame(() => focusNewNote())
    } catch (reason) {
      notify.error(reason)
    } finally {
      creating.delete('note')
    }
  }

  // Once the user moves on, a window created earlier no longer takes the camera.
  useEventListener(
    window,
    ['pointerdown', 'keydown', 'wheel', 'touchmove'],
    (event) => {
      if (shell.dialogOpen && creating.size) return
      scene.camera.release()
      const control =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>('.overview-create')
          : null
      if (
        control?.dataset.sourceId &&
        creating.has(creationId(control.dataset.sourceId, control.dataset.spaceId)) &&
        (event.type === 'pointerdown' ||
          (event instanceof KeyboardEvent && ['Enter', ' '].includes(event.key)))
      )
        return
      cancelReveal()
      scene.reveal.interacted(event)
    },
    { capture: true, passive: true },
  )

  return {
    creating,
    pendingCreated,
    creationId,
    cancelReveal,
    remember,
    forget() {
      lastInteraction = undefined
    },
    createSpace,
    createTab,
    editSpace,
    editWindow,
    focusCreated,
    focusNewNote,
    addNote,
  }
}
export type CanvasWindows = ReturnType<typeof useCanvasWindows>
