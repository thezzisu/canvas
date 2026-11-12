import { nextTick, shallowRef, watch } from 'vue'
import type { Node } from '@vue-flow/core'
import type { CanvasRequest } from './route'
import type { CanvasScene } from './scene'

interface Morph {
  phase: 'leave' | 'wait' | 'enter'
  /** Horizontal travel in pixels; its sign follows the canvases' sidebar order. */
  shift: number
  /** A window that jumps between canvases stays still while the rest moves. */
  anchor?: { sourceId: string; windowId: string }
}

/** Canvas switches move content along sidebar order: the old cards leave, the new enter. */
export function useCanvasMorph(scene: CanvasScene) {
  const state = shallowRef<Morph>()
  let animations: Animation[] = []

  function cancel() {
    for (const animation of animations) animation.cancel()
    animations = []
    state.value = undefined
  }
  /** Native animation completion follows reduced motion and cancellation. There
   * is no independent timer racing node initialization or a newer navigation. */
  async function finished() {
    await nextTick()
    const roots = [scene.surface.value, scene.focus.overlay.value].filter(
      (root): root is HTMLElement => !!root,
    )
    const running = roots
      .flatMap((root) => root.getAnimations({ subtree: true }))
      .filter(
        (animation) =>
          animation instanceof CSSAnimation && animation.animationName.startsWith('canvas-morph-'),
      )
    animations = running
    await Promise.allSettled(running.map((animation) => animation.finished))
    if (animations === running) animations = []
  }
  const presentable = () =>
    scene.graph.presented() &&
    scene.workspace.resourcesLoaded &&
    scene.workspace.pageVisible &&
    !scene.reducedMotion.value &&
    (scene.graph.nodes.value.length > 0 || scene.focus.maximized.value)

  /** Play the current canvas out before the route moves on. Resolves false if superseded. */
  async function leave(to: string, anchor?: Morph['anchor']) {
    cancel()
    if (!presentable()) return true
    const order = [
      'overview',
      'working-set',
      ...scene.workspace.orderedCanvases.map((canvas) => canvas.id),
    ]
    const morph: Morph = {
      phase: 'leave',
      shift: order.indexOf(to) < order.indexOf(scene.route.canvasId.value) ? -48 : 48,
      anchor: anchor && { sourceId: anchor.sourceId, windowId: anchor.windowId },
    }
    state.value = morph
    if (anchor) scene.graph.rebuild()
    await finished()
    if (state.value !== morph) return false
    state.value = { ...morph, phase: 'wait' }
    return true
  }
  /** The destination has its camera: let it enter. */
  function complete(_request?: CanvasRequest) {
    scene.graph.setPresented(true)
    const morph = state.value
    if (!morph || morph.phase !== 'wait') return
    if (scene.reducedMotion.value || !scene.workspace.pageVisible) {
      cancel()
      return
    }
    const entering = (state.value = { ...morph, phase: 'enter' })
    void finished().then(() => {
      if (state.value === entering) state.value = undefined
    })
  }
  watch([scene.reducedMotion, () => scene.workspace.pageVisible], ([reduced, visible]) => {
    if (reduced || !visible) cancel()
  })

  return {
    state,
    cancel,
    leave,
    complete,
    anchors(node: Node) {
      const anchor = state.value?.anchor
      return (
        !!anchor &&
        node.type === 'terminal' &&
        node.data.sourceId === anchor.sourceId &&
        node.data.windowId === anchor.windowId
      )
    },
  }
}
export type CanvasMorph = ReturnType<typeof useCanvasMorph>
