<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useEventListener, useResizeObserver } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import { MarkdownDocument } from '@comark/vue'
import type { MarkdownDocument as MarkdownTree } from 'comark'
import { ProseA, ProseBlockquote, ProseCode, ProseEm, ProseH1, ProseH2, ProseH3, ProseH4, ProseHr,
  ProseImg, ProseLi, ProseOl, ProseP, ProsePre, ProseStrong, ProseTable, ProseTbody, ProseTd, ProseTh, ProseThead, ProseTr, ProseUl } from '@nuxt/ui/components/prose'
import { isMarkdownFile, parseFileMarkdown } from '../markdown'
import type { ReadingPosition } from '../file-view'

const props = withDefaults(defineProps<{ text: string; filename: string; rendered?: boolean; wrap?: boolean; reading?: ReadingPosition; readOnly?: boolean }>(), { rendered: true, wrap: false, readOnly: false })
const emit = defineEmits<{ reading: [position: ReadingPosition] }>()
const { t } = useI18n()
const markdown = computed(() => isMarkdownFile(props.filename))
const renderMarkdown = computed(() => props.rendered && markdown.value)
const document = shallowRef<MarkdownTree>()
const failed = ref(false), loading = ref(false)
const readingElement = ref<HTMLElement>(), readingContent = ref<HTMLElement>()
let restoreFrame = 0, intentUntil = 0, pointerDown = false, layout = ''
const geometry = (element: HTMLElement) => [element.clientWidth, element.clientHeight, element.scrollWidth, element.scrollHeight].join(':')
function restoreReading() {
  intentUntil = 0; pointerDown = false
  cancelAnimationFrame(restoreFrame)
  restoreFrame = requestAnimationFrame(() => {
    restoreFrame = 0
    const element = readingElement.value
    if (!props.reading || !element?.clientWidth || !element.clientHeight || loading.value || failed.value) return
    // Browser clamping is only a presentation adjustment, never a saved user edit.
    element.scrollLeft = props.reading.x; element.scrollTop = props.reading.y
    layout = geometry(element)
  })
}
function readingIntent(event: Event) {
  if (props.readOnly || !props.reading || !readingElement.value || loading.value || failed.value) return
  if (event instanceof KeyboardEvent && !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) return
  intentUntil = performance.now() + 1200
  if (event.type === 'pointerdown') pointerDown = true
}
function rememberReading() {
  const element = readingElement.value
  if (!element || !props.reading || props.readOnly || loading.value || failed.value || restoreFrame) return
  if (geometry(element) !== layout) { restoreReading(); return }
  if (!pointerDown && performance.now() > intentUntil) return
  intentUntil = performance.now() + 1200
  emit('reading', { x: element.scrollLeft, y: element.scrollTop })
}
useResizeObserver([readingElement, readingContent], restoreReading)
useEventListener(readingElement, 'wheel', readingIntent, { passive: true })
useEventListener(readingElement, 'pointerdown', readingIntent, { passive: true })
useEventListener(readingElement, 'keydown', readingIntent)
useEventListener(readingElement, 'scroll', rememberReading, { passive: true })
useEventListener(readingElement, 'scrollend', () => { intentUntil = 0 })
useEventListener(window, ['pointerup', 'pointercancel', 'blur'], () => { pointerDown = false })
watch([readingElement, readingContent, renderMarkdown, () => props.wrap, () => props.text, loading], restoreReading, { flush: 'post' })
onBeforeUnmount(() => { cancelAnimationFrame(restoreFrame); pointerDown = false; intentUntil = 0 })
const prose = { ProseA, ProseBlockquote, ProseCode, ProseEm, ProseH1, ProseH2, ProseH3, ProseH4, ProseHr,
  ProseImg, ProseLi, ProseOl, ProseP, ProsePre, ProseStrong, ProseTable, ProseTbody, ProseTd, ProseTh, ProseThead, ProseTr, ProseUl }
let revision = 0
watch([() => props.text, renderMarkdown], async () => {
  const current = ++revision
  document.value = undefined; failed.value = false; loading.value = false
  if (!renderMarkdown.value) return
  loading.value = true
  try { const value = await parseFileMarkdown(props.text); if (current === revision) document.value = value }
  catch { if (current === revision) failed.value = true }
  finally { if (current === revision) loading.value = false }
}, { immediate: true })
</script>

<template>
  <div class="text-preview" :data-text-mode="renderMarkdown ? 'rendered' : 'source'">
    <pre v-if="!renderMarkdown" ref="readingElement" class="text-preview-source" :class="{ 'text-preview-wrap': wrap }" :aria-label="filename" tabindex="0"><span ref="readingContent" class="text-preview-lines">{{ text }}</span></pre>
    <div v-else ref="readingElement" class="text-preview-markdown" :aria-label="filename" tabindex="0">
      <div ref="readingContent" class="text-preview-document">
      <div v-if="loading" class="text-preview-status" role="status"><span class="spinner" />{{ t('common.loading') }}</div>
      <div v-else-if="failed" class="text-preview-status" role="alert">{{ t('panels.preview.unavailable') }}</div>
      <Suspense v-else-if="document"><MarkdownDocument :value="document" :components="prose" /><template #fallback><span class="spinner" /></template></Suspense>
      </div>
    </div>
  </div>
</template>

<style scoped>
.text-preview{display:flex;flex:1;flex-direction:column;min-height:0;min-width:0;width:100%;overflow:hidden;background:#14191f;color:#cdd5e1}
.text-preview-source,.text-preview-markdown{flex:1;min-width:0;min-height:0;overflow:auto;margin:0;padding:12px;user-select:text;-webkit-user-select:text;touch-action:pan-x pan-y;scrollbar-width:thin;outline:none}
.text-preview-source{font-family:var(--content-font-family,monospace);font-feature-settings:var(--content-font-features);font-size:13px;line-height:1.5;white-space:pre;tab-size:4}
.text-preview-wrap{white-space:pre-wrap;overflow-wrap:anywhere}
.text-preview-lines{display:block;min-width:100%;width:max-content}.text-preview-wrap .text-preview-lines{width:100%}
.text-preview-markdown{font-family:var(--content-font-family,monospace);font-feature-settings:var(--content-font-features);font-size:13px;line-height:1.65;overflow-wrap:anywhere}
.text-preview-document :deep(>div>*:first-child){margin-top:0}.text-preview-document :deep(>div>*:last-child){margin-bottom:0}.text-preview-markdown :deep(p){font-size:inherit;line-height:inherit;margin-block:10px}.text-preview-markdown :deep(pre){font-size:12px;max-width:100%;overflow:auto}.text-preview-markdown :deep(img){max-width:100%;height:auto}.text-preview-markdown :deep(a){overflow-wrap:anywhere}.text-preview-markdown :deep(table){font-size:12px}
.text-preview-status{display:flex;align-items:center;justify-content:center;gap:8px;min-height:80px;color:#8392a5;font-size:11px}
</style>
