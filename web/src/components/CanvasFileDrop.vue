<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import UProgress from '@nuxt/ui/components/Progress.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import { api, apiContext, apiRevision, requireCurrentApi, segment } from '../api'
import Icon from './Icon.vue'

const props = defineProps<{ canvasId?: string; getViewport: () => { x: number; y: number; zoom: number } }>()
const { t } = useI18n()
const marker = ref<HTMLElement>()
const dragging = ref(false)
const progress = ref<{ name: string; completed: number; total: number }>()
const error = ref('')
let host: HTMLElement | null = null, current: AbortController | undefined
const files = (event: DragEvent) => !!event.dataTransfer && ([...event.dataTransfer.types].includes('Files') || [...event.dataTransfer.items].some(item => item.kind === 'file'))
const blank = (event: DragEvent) => props.canvasId && !current && event.target instanceof Element &&
  !event.target.closest('.vue-flow__node,.vue-flow__minimap,.canvas-toolbar,.vue-flow__controls,button,input,textarea')
function over(event: DragEvent) {
  if (!files(event)) return
  event.preventDefault()
  dragging.value = !!blank(event)
  if (!dragging.value) { if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'; return }
  event.preventDefault(); event.stopPropagation()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
}
function preventNavigation(event: DragEvent) {
  if (!files(event)) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'
}
function leave(event: DragEvent) { if (!(event.relatedTarget instanceof Node) || !host?.contains(event.relatedTarget)) dragging.value = false }
function cancel() { current?.abort(); current = undefined; progress.value = undefined; dragging.value = false }
async function drop(event: DragEvent) {
  if (!files(event)) return
  event.preventDefault()
  if (!blank(event) || !host) return
  event.preventDefault(); event.stopImmediatePropagation(); dragging.value = false; error.value = ''
  if ([...event.dataTransfer?.items || []].some(item => item.webkitGetAsEntry?.()?.isDirectory)) {
    error.value = t('terminal.upload.foldersUnsupported'); return
  }
  const incoming = [...event.dataTransfer?.files || []]
  if (!incoming.length) return
  const canvasId = props.canvasId!, context = apiContext(), viewport = props.getViewport(), bounds = host.getBoundingClientRect()
  const position = { x: (event.clientX - bounds.left - viewport.x) / viewport.zoom, y: (event.clientY - bounds.top - viewport.y) / viewport.zoom }
  const request = current = new AbortController()
  try {
    for (const [index, file] of incoming.entries()) {
      requireCurrentApi(context)
      progress.value = { name: file.name, completed: index, total: incoming.length }
      const query = new URLSearchParams({ filename: file.name, size: String(file.size),
        x: String(Math.max(-1e7, Math.min(1e7, position.x + index * 24))),
        y: String(Math.max(-1e7, Math.min(1e7, position.y + index * 24))) })
      await api(`/api/canvases/${segment(canvasId)}/files?${query}`, { method: 'POST', body: file,
        headers: { 'Content-Type': 'application/octet-stream' }, signal: request.signal }, context)
    }
  } catch (reason) {
    if (!request.signal.aborted && !context.signal.aborted) error.value = reason instanceof Error ? reason.message : t('panels.file.addFailed')
  } finally { if (current === request) { current = undefined; progress.value = undefined } }
}
watch(apiRevision, () => { cancel(); error.value = '' })
onMounted(() => {
  document.addEventListener('dragover', preventNavigation); document.addEventListener('drop', preventNavigation)
  host = marker.value?.parentElement || null
  host?.addEventListener('dragenter', over); host?.addEventListener('dragover', over)
  host?.addEventListener('dragleave', leave); host?.addEventListener('drop', drop)
})
onBeforeUnmount(() => {
  document.removeEventListener('dragover', preventNavigation); document.removeEventListener('drop', preventNavigation)
  cancel(); host?.removeEventListener('dragenter', over); host?.removeEventListener('dragover', over)
  host?.removeEventListener('dragleave', leave); host?.removeEventListener('drop', drop)
})
</script>

<template>
  <div ref="marker" class="canvas-file-drop-layer">
    <div v-if="dragging" class="canvas-file-drop-mask"><Icon name="file" :size="23" /><span>{{ t('panels.file.dropToAdd') }}</span></div>
    <div v-if="progress || error" class="canvas-file-transfer" :role="error ? 'alert' : 'status'">
      <div><span class="canvas-file-transfer-name">{{ error || progress?.name }}</span><UButton color="neutral" variant="ghost" size="xs" :aria-label="t(progress ? 'terminal.upload.cancel' : 'common.close')" @click="progress ? cancel() : error = ''"><Icon name="close" :size="13" /></UButton></div>
      <UProgress v-if="progress" size="xs" color="neutral" :model-value="progress.total > 1 ? progress.completed : undefined" :max="progress.total" :aria-label="t('panels.file.adding')" />
    </div>
  </div>
</template>

<style scoped>
.canvas-file-drop-layer{position:absolute;inset:0;z-index:7;pointer-events:none}
.canvas-file-drop-mask{position:absolute;inset:12px;display:flex;align-items:center;justify-content:center;gap:10px;border:1px solid #d5aa8699;border-radius:10px;background:#171c25dd;color:#e8c5a7;font-size:13px;backdrop-filter:blur(3px)}
.canvas-file-transfer{position:absolute;left:50%;bottom:56px;translate:-50% 0;width:min(340px,calc(100% - 32px));padding:7px 10px;border:1px solid #424b58;border-radius:8px;background:#242a34f5;color:#bec9d8;box-shadow:0 5px 24px #0004;pointer-events:auto;font-size:11px}
.canvas-file-transfer>div{display:flex;align-items:center;gap:8px;min-width:0;margin-bottom:3px}.canvas-file-transfer-name{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
</style>
