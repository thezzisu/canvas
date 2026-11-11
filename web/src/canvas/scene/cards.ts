import { useI18n } from 'vue-i18n'
import { api, apiContext, isCurrentApi, segment } from '../../api/api'
import { notify } from '../../lib/notify'
import { focusWindow, hasLiveTerminal } from '../../terminal/terminals'
import { windowLabel } from '../../workspace/window-title'
import type { WindowMenuItem } from '../../workspace/WindowMenuDialog.vue'
import type { CardRemovalResponse } from '../../../../shared/card-removal'
import type { Canvas, TerminalCanvasNode } from '../../api/types'
import type { CanvasScene } from './scene'

type WindowRef = Pick<TerminalCanvasNode, 'sourceId' | 'spaceId' | 'windowId'>

/** What a card's controls do: maximize, remove, share, and the window menu. */
export function useCardActions(scene: CanvasScene) {
  const { workspace, edits, shell } = scene
  const { t } = useI18n()

  const scan = (node: WindowRef) => {
    const { window, spaceId } = workspace.resourceFor(node)
    shell.connectionsOpen = false
    scene.dialogs.scan({
      sourceId: node.sourceId,
      spaceId,
      windowId: node.windowId,
      name: windowLabel(window || { name: t('app.window') }),
    })
  }
  /** Add this window to another canvas; Overview windows may start a new one. */
  async function addToCanvas(node?: WindowRef) {
    if (!(await scene.layout.leave())) return
    const canvasId = await scene.dialogs.addWindows({
      window: node,
      preferred: scene.canvas.value?.id,
    })
    if (canvasId) void scene.visit(canvasId, { fitAll: true })
  }
  /** Remove a card from this canvas, offering to undo until the server forgets it. */
  async function remove(id: string) {
    const canvas = scene.canvas.value
    const node = canvas?.nodes.find((node) => node.id === id)
    if (!canvas || !node) return
    const context = apiContext()
    const removal = scene.removalUndo.begin(canvas.id, node, context)
    if (!removal) return
    let offered = false
    try {
      if (!(await edits.flushNotes(canvas.id)) || !isCurrentApi(context)) return
      await edits.flushLayout(canvas.id)
      const saved = workspace.canvases
        .find((item) => item.id === canvas.id)
        ?.nodes.find((node) => node.id === id)
      if (!isCurrentApi(context) || !saved) return
      const name =
        saved.type === 'terminal'
          ? workspace.resourceFor(saved).window?.name || t('app.window')
          : saved.type === 'file'
            ? saved.asset.filename
            : saved.title || t('app.note')
      const started = performance.now()
      const result = await api<CardRemovalResponse<Canvas>>(
        `/api/canvases/${segment(canvas.id)}/nodes/${segment(id)}`,
        { method: 'DELETE' },
        context,
      )
      if (!isCurrentApi(context)) return
      edits.discard(canvas.id, id)
      scene.removalUndo.offer(removal, result.undo, started, name, result.lastReference)
      offered = true
      await workspace.sync()
    } catch (reason) {
      if (isCurrentApi(context)) notify.error(reason)
    } finally {
      if (!offered) scene.removalUndo.release(removal)
    }
  }

  /** The window's actions as a dialog: the touch card menu and the connections panel use it. */
  function windowMenu(node: TerminalCanvasNode) {
    const live = workspace.resourceFor(node).window
    const maximized = scene.focus.terminal.value?.id === node.id && !!node.id
    const items: WindowMenuItem[][] = [
      [
        ...(shell.mobile && maximized
          ? [
              {
                label: t('terminal.action.showKeyboard'),
                icon: 'i-lucide-keyboard',
                value: 'keyboard',
                // The keyboard belongs to the terminal, not to the menu's trigger.
                focus: () => void focusWindow(node.sourceId, node.spaceId, node.windowId, true),
              },
            ]
          : []),
        ...(shell.mobile
          ? [{ label: t('common.settings'), icon: 'i-lucide-settings', value: 'settings' }]
          : []),
        ...(shell.mobile && scene.custom.value && node.id
          ? [
              {
                label: t('app.newTab'),
                icon: 'i-lucide-square-plus',
                disabled: !live || !!workspace.resourceFor(node).source?.error,
                value: 'tab',
              },
            ]
          : []),
        {
          label: t('panels.scan.title'),
          icon: 'i-lucide-scan-text',
          disabled: !hasLiveTerminal(node.sourceId, node.windowId),
          value: 'scan',
        },
        { label: t('app.addToOtherCanvas'), icon: 'i-lucide-layers', value: 'add' },
        { label: t('app.renameWindow'), icon: 'i-lucide-pencil', value: 'rename' },
      ],
      [{ label: t('app.closeWindow'), icon: 'i-lucide-trash', color: 'error', value: 'close' }],
    ]
    void scene.dialogs.windowMenu({ target: node, items }).then((action) => {
      if (action === 'settings') scene.dialogs.settings()
      else if (action === 'tab') scene.graph.terminalData(node).newTab?.create()
      else if (action === 'scan') scan(node)
      else if (action === 'add') void addToCanvas(node)
      else if (action === 'rename' || action === 'close') scene.windows.editWindow(node, action)
    })
  }

  function terminalAction(action: string, id: string) {
    const node = scene.graph.terminalOf(id) || scene.focus.terminal.value
    if (!node) return
    if (action === 'add') void addToCanvas(node)
    else if (action === 'remove') void remove(id)
    else if (action === 'rename' || action === 'close') scene.windows.editWindow(node, action)
    else if (action === 'scan') scan(node)
    else if (action === 'menu') windowMenu(node)
    else if (action === 'unfocus') void scene.focus.closeTerminal()
    else if (action === 'focus') {
      if (scene.paging.active.value) scene.paging.showWindow(node)
      scene.camera.queueResize()
      scene.focus.maximizeTerminal(node)
    }
  }
  function cardAction(action: string, id: string) {
    if (action === 'settings') scene.dialogs.settings()
    else if (action === 'remove') void remove(id)
    else if (action === 'unfocus') void scene.focus.closeCard()
    else if (action === 'focus') {
      scene.menus.canvas.value = false
      scene.focus.maximizeCard(id)
    } else if (action === 'add') {
      const canvas = scene.canvas.value,
        node = canvas?.nodes.find((item) => item.id === id)
      if (canvas && node && node.type !== 'terminal')
        scene.dialogs.shareCard({ canvasId: canvas.id, node })
    }
  }

  return { terminalAction, cardAction, remove, addToCanvas, windowMenu, scan }
}
export type CardActions = ReturnType<typeof useCardActions>
