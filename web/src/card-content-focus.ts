import { computed, type Ref } from 'vue'
import { useDocumentFocus } from './document-focus'

/** Content focus is distinct from selecting or dragging the card. */
export function useCardContentFocus(body: Ref<HTMLElement | undefined>, readOnly: () => boolean) {
  const { activeElement, windowFocused } = useDocumentFocus()
  const active = computed(() => {
    const element = activeElement.value
    // Native viewers retain activation until focus moves elsewhere in this page.
    // Their child-window focus events are not exposed to the parent document.
    return !readOnly() && (windowFocused.value || element instanceof HTMLIFrameElement) &&
      !!element && !!body.value?.contains(element) && !element.closest('.card-content-activate')
  })
  function focus() { if (!readOnly()) body.value?.focus({ preventScroll: true }) }
  function pointerDown(event: PointerEvent) {
    if (readOnly() || event.button !== 0 || !(event.target instanceof Element)) return
    const nativeTarget = event.target.closest('a[href],button,input,textarea,select,[contenteditable],audio,video,iframe,[tabindex]')
    if (nativeTarget && (nativeTarget !== body.value || nativeTarget.matches('input,textarea,select,[contenteditable]'))) return
    if (!body.value?.contains(document.activeElement)) focus()
  }
  return { active, focus, pointerDown }
}
