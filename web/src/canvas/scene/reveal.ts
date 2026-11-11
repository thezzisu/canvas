import { computed, nextTick, shallowRef, watch } from 'vue'
import type { Node } from '@vue-flow/core'
import { apiContext, isCurrentApi } from '../../api/api'
import { activeInstance } from '../../instances/instances'
import { notificationSurface } from '../../notifications/notification-surface'
import { notificationTarget } from '../../notifications/notification-model'
import { focusWindow, terminalReadFocus } from '../../terminal/terminals'
import { terminalIdentityKey } from '../../terminal/terminal-identity'
import { lastWindowCanvas, useWindowCanvasHistory } from '../../workspace/window-canvas'
import type { WindowFocus } from '../../workspace/completion-focus'
import type { CanvasNotification } from '../../../../shared/notification'
import {
  adjacentCanvas,
  canvasAnchor,
  type CanvasAnchor,
  type CanvasDirection,
} from '../canvas-jump'
import { isTerminalNode, type TerminalCanvasNode } from '../../api/types'
import { windowNode } from './graph'
import type { CanvasScene } from './scene'

type JumpFocus = 'terminal' | 'button' | undefined
const FOCUS_ATTEMPTS = 30

/** Going to a particular window: from a notification, the sidebar, or a card's canvas jump. */
export function useWindowReveal(scene: CanvasScene) {
  const { workspace, shell, flow } = scene
  const { nodes, getViewport, getNodesInitialized } = flow
  /** A window to bring into view on a canvas, once that canvas and its nodes are there. */
  const reveal = shallowRef<{ canvasId: string; target: WindowFocus; pending: boolean }>()
  /** A terminal that takes keyboard focus as soon as it is connected and visible. */
  const focus = shallowRef<{
    canvasId: string
    sourceId: string
    spaceId: string
    windowId: string
  }>()
  /** A card's jump to its neighbouring canvas keeps that window fixed on screen. */
  const jumping = shallowRef<{
    canvasId: string
    anchor: CanvasAnchor
    focus: JumpFocus
    direction: CanvasDirection
  }>()
  let intent = 0

  function cancel() {
    intent++
    reveal.value = undefined
    focus.value = undefined
  }
  /** Whether a notification may take the user elsewhere right now. */
  const available = computed(
    () =>
      !scene.layout.busy.value &&
      (!notificationSurface.value ||
        (!!notificationSurface.value.closest('.overlay-root') &&
          shell.settingsOpen &&
          !shell.dialogOpen)),
  )
  function prepare() {
    if (!available.value) return false
    scene.focus.clearContent()
    scene.dialogs.closeSettings()
    return true
  }
  const online = (target: WindowFocus) =>
    workspace.resources.some(
      (source) =>
        source.id === target.sourceId &&
        source.status === 'online' &&
        !source.error &&
        source.spaces.some((space) =>
          space.windows.some((window) => window.id === target.windowId),
        ),
    )
  const holds = (canvasId: string, target: WindowFocus) =>
    canvasId === 'overview' ||
    !!workspace.canvases
      .find((canvas) => canvas.id === canvasId)
      ?.nodes.some(
        (node) =>
          isTerminalNode(node) &&
          node.sourceId === target.sourceId &&
          node.windowId === target.windowId,
      )

  /** Open a window's card on a canvas that holds it, then focus its terminal. */
  async function goTo(canvasId: string, target: WindowFocus) {
    const context = apiContext()
    if (!(await scene.layout.leave()) || !isCurrentApi(context) || !prepare()) return
    cancel()
    const started = intent
    if (canvasId === scene.route.canvasId.value) await scene.focus.close()
    if (!isCurrentApi(context) || started !== intent) return
    if (!online(target) || !holds(canvasId, target)) return
    reveal.value = { canvasId, target, pending: true }
    shell.closePanels()
    if (canvasId !== scene.route.canvasId.value) {
      void scene.visit(canvasId)
      return
    }
    scene.graph.rebuild()
    await nextTick()
    if (isCurrentApi(context) && started === intent) void show()
  }
  /** The canvas where this browser last used the window; Overview if it never has. */
  async function goToWindow(target: WindowFocus) {
    const source = workspace.sources.find((item) => item.id === target.sourceId)
    if (!source || !workspace.state) return
    await goTo(
      lastWindowCanvas(
        terminalIdentityKey(activeInstance.value.id, source, target.windowId),
        target.sourceId,
        target.windowId,
        workspace.canvases,
      ),
      target,
    )
  }
  /** Centre the revealed window (maximize it on touch) once its card is measured. */
  async function show() {
    const request = reveal.value
    if (
      !request?.pending ||
      request.canvasId !== scene.route.canvasId.value ||
      scene.camera.restoring() ||
      scene.route.request.value ||
      scene.focus.maximized.value
    )
      return
    const card = windowNode(nodes.value, request.target)
    if (!card) {
      cancel()
      return
    }
    if (!getNodesInitialized.value.some((node) => node.id === card.id)) return
    const settled = (reveal.value = { ...request, pending: false })
    // Touch cards stay read-only: frame the card, then let the maximized view own interaction.
    if (shell.mobile) await scene.camera.centre(card)
    else await scene.camera.show(card)
    if (reveal.value !== settled) return
    scene.focus.selected.value = request.target
    focus.value = { canvasId: request.canvasId, ...request.target, spaceId: card.data.spaceId }
    if (shell.mobile) scene.cards.terminalAction('focus', card.id)
  }
  /** Open the notification's window maximized where the user is, without changing canvas. */
  async function open(event: CanvasNotification) {
    if (!(await scene.layout.leave()) || !prepare()) return
    cancel()
    const found = notificationTarget(event, workspace.resources)
    if (!found) return
    const context = apiContext(),
      started = intent
    await scene.focus.close()
    if (!isCurrentApi(context) || started !== intent) return
    const window = { sourceId: event.sourceId, windowId: found.window.id }
    const placed = scene.canvas.value?.nodes.find(
      (node): node is TerminalCanvasNode =>
        isTerminalNode(node) &&
        node.sourceId === window.sourceId &&
        node.windowId === window.windowId,
    )
    const node: TerminalCanvasNode = placed || {
      type: 'terminal',
      id: `notification:${window.sourceId}/${window.windowId}`,
      ...window,
      spaceId: found.space.id,
      x: 0,
      y: 0,
      ...workspace.windowSize(window),
    }
    scene.focus.maximizeTerminal(node)
    focus.value = { canvasId: scene.route.canvasId.value, ...window, spaceId: node.spaceId }
  }
  async function goToNotification(event: CanvasNotification) {
    const found = notificationTarget(event, workspace.resources)
    if (found) await goToWindow({ sourceId: event.sourceId, windowId: found.window.id })
  }
  // Logical focus already accounts for connection and visibility. Reuse its
  // readiness for delayed mounts; automatic reads still wait for painted output.
  watch(
    [focus, terminalReadFocus],
    ([target, ready]) => {
      if (
        target &&
        target.canvasId === scene.route.canvasId.value &&
        ready?.sourceId === target.sourceId &&
        ready.windowId === target.windowId &&
        focusWindow(target.sourceId, target.spaceId, target.windowId, false)
      )
        focus.value = undefined
    },
    { flush: 'post' },
  )

  /** Follow a window to the previous or next canvas that also shows it. */
  function jump(nodeId: string, direction: CanvasDirection, focusAfter: JumpFocus) {
    const node = scene.graph.terminalOf(nodeId),
      card = nodes.value.find((item) => item.id === nodeId)
    if (!node || !card || scene.focus.maximized.value) return
    const next = adjacentCanvas(
      workspace.windowCanvases(node.sourceId, node.windowId),
      scene.route.canvasId.value,
      direction,
    )
    if (!next) return
    const anchor = canvasAnchor(node, card.position, getViewport())
    jumping.value = { canvasId: next.id, anchor, focus: focusAfter, direction }
    void scene.visit(next.id, { anchor })
  }
  function finishJump(card: Node) {
    const done = jumping.value
    jumping.value = undefined
    if (!done || done.canvasId !== scene.route.canvasId.value) return
    const { sourceId, windowId } = done.anchor
    scene.focus.selected.value = { sourceId, windowId }
    if (!done.focus) return
    // The cached terminal moves into the destination card; keep keyboard context there.
    const restore = (attempt = 0) => {
      if (
        jumping.value ||
        scene.route.canvasId.value !== done.canvasId ||
        scene.focus.maximized.value
      )
        return
      const button = document.querySelector<HTMLButtonElement>(
        `.vue-flow__node[data-id="${CSS.escape(card.id)}"] .card-${done.direction}-canvas`,
      )
      const focused =
        done.focus === 'terminal'
          ? focusWindow(sourceId, card.data.spaceId, windowId)
          : !!button &&
            ((button.disabled ? button.closest<HTMLElement>('.vue-flow__node') : button)?.focus({
              preventScroll: true,
            }),
            true)
      if (!focused && attempt < FOCUS_ATTEMPTS) requestAnimationFrame(() => restore(attempt + 1))
    }
    restore()
  }

  // Remember which canvas each native window was last used on.
  useWindowCanvasHistory(
    () => {
      const element = scene.focus.activeElement.value
      if (
        scene.layout.editing.value ||
        !workspace.pageVisible ||
        !scene.focus.windowFocused.value ||
        !element?.matches('.xterm-helper-textarea, .terminal-mobile-input')
      )
        return
      const card = element.closest<HTMLElement>('.terminal-card'),
        sourceId = card?.dataset.sourceId,
        windowId = card?.dataset.windowId
      const source = workspace.sources.find((item) => item.id === sourceId)
      if (!source || !sourceId || !windowId || !workspace.state) return
      // A notification may maximize a window on a canvas that has no card for it.
      if (
        scene.kind.value === 'working-set' ||
        !holds(scene.route.canvasId.value, { sourceId, windowId })
      )
        return
      return terminalIdentityKey(activeInstance.value.id, source, windowId)
    },
    () => scene.route.canvasId.value,
    scene.focus.activeElement,
  )

  return {
    available,
    cancel,
    goTo,
    goToWindow,
    goToNotification,
    open,
    show,
    jump,
    finishJump,
    cancelJump() {
      jumping.value = undefined
    },
    /** The window a canvas is asked to keep visible: a pending reveal or an arriving jump. */
    target(canvasId: string): WindowFocus | undefined {
      if (reveal.value?.canvasId === canvasId) return reveal.value.target
      if (jumping.value?.canvasId === canvasId) return jumping.value.anchor
    },
    /** Input anywhere but the revealed card gives up the reveal. */
    interacted(event: Event) {
      const card =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>('.terminal-card')
          : undefined
      const target = reveal.value?.target
      if (
        !target ||
        card?.dataset.sourceId !== target.sourceId ||
        card?.dataset.windowId !== target.windowId
      )
        cancel()
    },
  }
}
export type WindowReveal = ReturnType<typeof useWindowReveal>
