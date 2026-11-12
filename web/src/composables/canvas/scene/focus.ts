import { computed, nextTick, ref, shallowRef, watch } from 'vue'
import { useEventListener } from '@vueuse/core'
import { apiContext, apiRevision, isCurrentApi } from '../../../api/api'
import { cardMenuOpen } from '../card-menu'
import { useDocumentFocus } from '../../document-focus'
import { hideMobileKeyboard } from '../../terminal/mobile-keyboard'
import {
  liveTerminalMetadata,
  prepareTerminalReadFocus,
  setTerminalReadFocus,
} from '../../terminal/terminals'
import type { WindowFocus } from '../../../utils/workspace/completion-focus'
import type { FileCanvasNode, NoteCanvasNode, TerminalCanvasNode } from '../../../api/types'
import { windowKey } from '../../../stores/workspace'
import type { CanvasScene } from './scene'

/** What holds the user's attention: a maximized card, and the terminal they last chose. */
export function useCardFocus(scene: CanvasScene) {
  const { workspace, shell, session, edits } = scene
  /** The maximized terminal. It may be a window the current canvas holds no card for. */
  const terminal = ref<TerminalCanvasNode | null>(null)
  /** The maximized note or file card. */
  const cardId = ref('')
  const card = computed(() =>
    scene.canvas.value?.nodes.find(
      (node): node is NoteCanvasNode | FileCanvasNode =>
        node.id === cardId.value && node.type !== 'terminal',
    ),
  )
  const maximized = computed(() => !!terminal.value || !!cardId.value)
  /** The terminal chosen by pointer or keyboard; it keeps logical focus between inputs. */
  const selected = shallowRef<WindowFocus>()
  /** Focus requests that wait for a mount; cleared whenever content focus is given up. */
  const pending = { note: '' }
  const overlay = ref<HTMLElement>()
  const { activeElement, windowFocused } = useDocumentFocus()

  watch(card, (value) => {
    shell.cardMaximized = !!value
    if (cardId.value && !value) void closeCard()
  })

  /** Reading follows the terminal the user is actually looking at and able to type into. */
  const logical = computed<WindowFocus | undefined>(() => {
    if (
      !session.authenticated ||
      !workspace.pageVisible ||
      !windowFocused.value ||
      shell.modalOpen ||
      cardMenuOpen.value ||
      activeElement.value?.closest('[role="menu"]') ||
      shell.sidebarOpen ||
      shell.connectionsOpen ||
      cardId.value
    )
      return
    return terminal.value || selected.value
  })
  watch(logical, (value) => setTerminalReadFocus(value), { flush: 'sync', immediate: true })

  function clearContent() {
    selected.value = undefined
    pending.note = ''
    const active = document.activeElement
    if (active instanceof HTMLElement && active.closest('.card-content')) active.blur()
    hideMobileKeyboard()
  }
  watch([scene.route.canvasId, apiRevision], clearContent, { flush: 'sync' })

  function blurOverlay() {
    const active = document.activeElement
    if (active instanceof HTMLElement && overlay.value?.contains(active)) active.blur()
  }
  /** Back from a maximized card to the canvas, at the camera it had before. */
  async function restore() {
    const context = apiContext(),
      canvasId = scene.route.canvasId.value
    scene.graph.remount()
    await nextTick()
    if (!isCurrentApi(context) || scene.route.canvasId.value !== canvasId || maximized.value) return
    await scene.camera.restore()
  }
  async function closeTerminal() {
    terminal.value = null
    clearContent()
    blurOverlay()
    await restore()
  }
  async function closeCard() {
    clearContent()
    blurOverlay()
    void edits.flushNotes(scene.route.canvasId.value)
    cardId.value = ''
    await restore()
  }
  async function close() {
    if (cardId.value) await closeCard()
    if (terminal.value) await closeTerminal()
  }
  function maximizeTerminal(node: TerminalCanvasNode) {
    shell.closePanels()
    scene.camera.save()
    selected.value = { sourceId: node.sourceId, windowId: node.windowId }
    terminal.value = node
  }
  function maximizeCard(id: string) {
    if (!scene.canvas.value?.nodes.some((node) => node.id === id && node.type !== 'terminal'))
      return
    shell.closePanels()
    hideMobileKeyboard()
    scene.camera.save()
    cardId.value = id
  }
  /** Leaving a canvas drops its maximized card without restoring the old graph beneath it. */
  function reset() {
    terminal.value = null
    cardId.value = ''
  }

  // The maximized window closed natively, or its card left this canvas.
  watch(
    () => terminal.value && liveTerminalMetadata.value.get(windowKey(terminal.value)) === null,
    (closed) => {
      if (closed) void closeTerminal()
    },
  )
  const referenced = computed(
    () => !!scene.canvas.value?.nodes.some((node) => node.id === terminal.value?.id),
  )
  watch(referenced, (now, before) => {
    if (before && !now && terminal.value && scene.custom.value) void closeTerminal()
  })
  watch(
    () => workspace.sources.map((source) => source.id),
    (ids) => {
      if (terminal.value && !ids.includes(terminal.value.sourceId)) terminal.value = null
    },
  )

  function select(event: Event) {
    if (scene.layout.editing.value) return
    if (!(event.target instanceof Element) || (event instanceof PointerEvent && event.button !== 0))
      return
    if (event.target.closest('.card-header-actions, [role="menu"]')) return
    const element =
      event.target.closest<HTMLElement>('.terminal-card') ||
      (event instanceof KeyboardEvent &&
      ['Enter', ' '].includes(event.key) &&
      event.target.matches('.vue-flow__node')
        ? event.target.querySelector<HTMLElement>('.terminal-card')
        : undefined)
    if (element?.dataset.sourceId && element.dataset.windowId) {
      if (
        element.classList.contains('terminal-mobile-preview') ||
        element.dataset.presentation === 'paused' ||
        element.dataset.connectionStatus === 'closed'
      )
        return
      const target = { sourceId: element.dataset.sourceId, windowId: element.dataset.windowId }
      if (event instanceof PointerEvent && event.target.closest('.terminal-host'))
        prepareTerminalReadFocus(target)
      selected.value = target
    } else if (
      event.target.closest('.note-card, .file-card, .vue-flow__pane, .empty-state') &&
      !event.target.closest('.canvas-toolbar, .vue-flow__minimap')
    )
      selected.value = undefined
  }
  useEventListener(window, ['pointerdown', 'keydown'], select, { capture: true, passive: true })

  return {
    terminal,
    cardId,
    card,
    maximized,
    selected,
    pending,
    overlay,
    activeElement,
    windowFocused,
    clearContent,
    maximizeTerminal,
    maximizeCard,
    closeTerminal,
    closeCard,
    close,
    reset,
  }
}
export type CardFocus = ReturnType<typeof useCardFocus>
