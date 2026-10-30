import { viewportPolicy } from './developer-mode'

export interface ViewportFrame { width: number; height: number; top: number; left: number }
interface VisualFrame { width: number; height: number; offsetTop: number; offsetLeft: number }
export function viewportFrame(layout: { width: number; height: number }, visual?: VisualFrame | null,
  policy: 'resizes-content' | 'resizes-visual' = 'resizes-content'): ViewportFrame {
  if (policy === 'resizes-content') return { ...layout, top: 0, left: 0 }
  const positive = (value: number | undefined, fallback: number) => value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
  const offset = (value: number | undefined) => value !== undefined && Number.isFinite(value) ? Math.max(0, value) : 0
  return { width: positive(visual?.width, layout.width), height: positive(visual?.height, layout.height),
    top: offset(visual?.offsetTop), left: offset(visual?.offsetLeft) }
}

const probes = new WeakMap<Document, HTMLElement>()
/** Measure the CSS viewport independently of rounded innerHeight or keyboard overlays. */
export function viewportProbe(): HTMLElement {
  let probe = probes.get(document)
  if (!probe) {
    probe = document.createElement('i')
    probe.setAttribute('aria-hidden', 'true')
    probe.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:100dvw;height:100dvh;visibility:hidden;pointer-events:none;contain:strict'
    document.body.append(probe)
    probes.set(document, probe)
  }
  return probe
}
export function readViewportFrame(): ViewportFrame {
  const { width, height } = viewportProbe().getBoundingClientRect()
  return viewportFrame({ width, height }, window.visualViewport, viewportPolicy.value.interactiveWidget)
}
