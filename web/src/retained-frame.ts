import { onBeforeUnmount, watch, type Ref } from 'vue'
import { useMobileLayout } from './mobile-layout'
import { bindDocumentInput } from './document-input'

/** One iframe per resource survives card remounts, maximize and canvas switches.
 * `moveBefore` keeps the frame's document alive while it changes parent; browsers
 * without it reload the frame, as an ordinary remount would. */
export interface RetainedFrame {
  key: string
  src: string
  attributes: Record<string, string>
}
interface Entry {
  frame: HTMLIFrameElement
  owner?: symbol
  timer?: ReturnType<typeof setTimeout>
}
const frames = new Map<string, Entry>()
const PARKED_MS = 5 * 60_000
let parking: HTMLElement | undefined

function park() {
  if (parking?.isConnected) return parking
  parking = document.createElement('div')
  parking.setAttribute('aria-hidden', 'true')
  parking.inert = true
  parking.style.cssText =
    'position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;pointer-events:none;visibility:hidden'
  document.body.append(parking)
  return parking
}
function move(parent: Element, frame: HTMLIFrameElement) {
  const atomic = (parent as Element & { moveBefore?: (node: Node, child: Node | null) => void })
    .moveBefore
  if (atomic && frame.isConnected && parent.isConnected) atomic.call(parent, frame, null)
  else parent.append(frame)
}
function destroy(key: string) {
  const entry = frames.get(key)
  if (!entry) return
  clearTimeout(entry.timer)
  entry.frame.remove()
  frames.delete(key)
}

export function useRetainedFrame(
  host: Ref<HTMLElement | undefined>,
  spec: () => RetainedFrame | undefined,
) {
  const owner = Symbol('frame owner')
  const touch = useMobileLayout()
  let releaseInput: (() => void) | undefined
  let current: string | undefined
  const release = () => {
    releaseInput?.()
    releaseInput = undefined
    const entry = current === undefined ? undefined : frames.get(current)
    if (entry?.owner === owner) {
      const rect = entry.frame.getBoundingClientRect()
      // Parked frames keep their last size so the page inside does not reflow.
      if (rect.width && rect.height) {
        entry.frame.style.width = `${rect.width}px`
        entry.frame.style.height = `${rect.height}px`
      }
      entry.owner = undefined
      move(park(), entry.frame)
      const key = current!
      entry.timer = setTimeout(() => destroy(key), PARKED_MS)
    }
    current = undefined
  }
  watch(
    [host, spec],
    ([element, value]) => {
      if (!element || !value) {
        release()
        return
      }
      if (current !== value.key) release()
      let entry = frames.get(value.key)
      if (!entry) {
        const frame = document.createElement('iframe')
        frame.src = value.src
        entry = { frame }
        frames.set(value.key, entry)
      }
      clearTimeout(entry.timer)
      entry.timer = undefined
      releaseInput ??= bindDocumentInput(entry.frame, touch)
      for (const [name, attribute] of Object.entries(value.attributes))
        entry.frame.setAttribute(name, attribute)
      entry.frame.style.width = ''
      entry.frame.style.height = ''
      entry.owner = owner
      current = value.key
      if (entry.frame.parentElement !== element) move(element, entry.frame)
    },
    { immediate: true, flush: 'post' },
  )
  onBeforeUnmount(release)
}

/** Drops retained frames whose key starts with a prefix, e.g. an ended capture or a signed-out instance. */
export function discardFrames(prefix = '') {
  for (const key of [...frames.keys()]) if (key.startsWith(prefix)) destroy(key)
}
