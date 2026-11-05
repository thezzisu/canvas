import { computed, ref, watch, type Ref } from 'vue'
import { useEventListener } from '@vueuse/core'

/** UI-only context: an independent tab uses its own canonical input-mode resolver. */
export function useDocumentInputMode(fallback: Ref<boolean>) {
  const parentTouch = ref<boolean>()
  let parentOrigin: string | undefined
  const announce = () => { if (window.parent !== window) window.parent.postMessage({ type: 'canvas:document-ready' }, '*') }
  useEventListener(window, 'message', event => {
    if (window.parent === window || event.source !== window.parent || parentOrigin && event.origin !== parentOrigin
      || !['canvas:document-query', 'canvas:document-input'].includes(event.data?.type)) return
    parentOrigin ??= event.origin
    if (event.data?.type === 'canvas:document-query') announce()
    if (event.data?.type === 'canvas:document-input' && typeof event.data.touch === 'boolean') parentTouch.value = event.data.touch
  })
  announce()
  return computed(() => parentTouch.value ?? fallback.value)
}

/** Bound to a retained frame's active owner, and only active after that document's handshake. */
export function bindDocumentInput(frame: HTMLIFrameElement, touch: Ref<boolean>) {
  const origin = new URL(frame.src).origin
  let documentReady = false
  const send = () => { if (documentReady) frame.contentWindow?.postMessage({ type: 'canvas:document-input', touch: touch.value }, origin) }
  const query = () => { documentReady = false; frame.contentWindow?.postMessage({ type: 'canvas:document-query' }, origin) }
  const ready = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow || event.origin !== origin || event.data?.type !== 'canvas:document-ready') return
    documentReady = true; send()
  }
  window.addEventListener('message', ready)
  frame.addEventListener('load', query)
  const stop = watch(touch, send); query()
  return () => { window.removeEventListener('message', ready); frame.removeEventListener('load', query); stop() }
}
