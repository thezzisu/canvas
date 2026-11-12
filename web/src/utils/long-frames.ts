/** A frame that kept the page from responding, with the scripts that ran in it. */
export interface LongFrame {
  /** Seconds since the page loaded. */
  at: number
  duration: number
  /** Time spent in style and layout that a script forced. */
  layout: number
  scripts: Array<{ invoker: string; source: string; duration: number }>
}
interface ScriptTiming {
  invoker: string
  sourceURL: string
  sourceFunctionName: string
  sourceCharPosition: number
  duration: number
  forcedStyleAndLayoutDuration: number
}
const frames: LongFrame[] = []
// A frame this long is felt as a freeze.
const threshold = 200

/** Keep the most recent freezes for the developer diagnostics. */
export function recordLongFrames() {
  if (!PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame')) return
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.duration < threshold) continue
      const scripts = (entry as PerformanceEntry & { scripts: ScriptTiming[] }).scripts
      frames.push({
        at: Math.round(entry.startTime / 100) / 10,
        duration: Math.round(entry.duration),
        layout: Math.round(
          scripts.reduce((sum, script) => sum + script.forcedStyleAndLayoutDuration, 0),
        ),
        scripts: scripts
          .filter((script) => script.duration >= 20)
          .map((script) => ({
            invoker: script.invoker,
            source: `${script.sourceFunctionName}@${script.sourceURL.split('/').pop()}:${script.sourceCharPosition}`,
            duration: Math.round(script.duration),
          })),
      })
      if (frames.length > 40) frames.shift()
    }
  }).observe({ type: 'long-animation-frame', buffered: true })
}
export const longFrames = (): readonly LongFrame[] => frames
