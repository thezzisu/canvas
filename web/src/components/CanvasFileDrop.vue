<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useEventListener, useFileDialog } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import UProgress from '@nuxt/ui/components/Progress.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import { api, apiContext, apiRevision, requireCurrentApi, segment } from '../api'
import { hasFileTransfer, readFileTransfer } from '../browser-file-input'
import Icon from './Icon.vue'

const props = defineProps<{ canvasId?: string; canvasName?: string; getViewport: () => { x: number; y: number; zoom: number } }>()
const { t } = useI18n()
const marker = ref<HTMLElement>()
const dragging = ref(false)
const progress = ref<{ name: string; canvasId: string; canvasName: string }>()
const error = ref('')
const host = computed(() => marker.value?.parentElement)
let current: AbortController | undefined
const blank = (target: EventTarget | null) => target instanceof Element &&
  !target.closest('.vue-flow__node,.vue-flow__minimap,.canvas-toolbar,.vue-flow__controls,button,input,textarea')
// Observe before child editors stop bubbling, but never claim their drop.
function track(event: DragEvent) {
  if (hasFileTransfer(event.dataTransfer)) dragging.value = !!props.canvasId && !current && blank(event.target)
}
function over(event: DragEvent) {
  if (!hasFileTransfer(event.dataTransfer) || !blank(event.target)) return
  event.preventDefault(); event.stopPropagation()
  if (event.dataTransfer) event.dataTransfer.dropEffect = props.canvasId && !current ? 'copy' : 'none'
}
function clearDrag() { dragging.value = false }
function preventNavigation(event: DragEvent) {
  if (!hasFileTransfer(event.dataTransfer) || event.defaultPrevented) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'
}
function leave(event: DragEvent) { if (!(event.relatedTarget instanceof Node) || !host.value?.contains(event.relatedTarget)) dragging.value = false }
function cancel() { current?.abort(); current = undefined; progress.value = undefined; dragging.value = false }
function admission(files: File[]) {
  if (files.some(file => file.webkitRelativePath)) return 'terminal.upload.foldersUnsupported'
  if (files.length > 1) return 'panels.file.singleOnly'
  if (!files.length) return 'panels.file.unreadableTransfer'
  return current ? 'panels.file.uploadBusy' : undefined
}
type Target = { canvasId: string; canvasName: string; context: ReturnType<typeof apiContext>; position: { x: number; y: number } }
function targetAt(x: number, y: number): Target | undefined {
  if (!props.canvasId) return
  const viewport = props.getViewport()
  return { canvasId: props.canvasId, canvasName: props.canvasName || '', context: apiContext(),
    position: { x: (x - viewport.x) / viewport.zoom, y: (y - viewport.y) / viewport.zoom } }
}
async function drop(event: DragEvent) {
  if (!hasFileTransfer(event.dataTransfer) || event.defaultPrevented ||
    event.target instanceof Element && event.target.closest('.terminal-card,.note-editor-content')) return
  event.preventDefault(); event.stopPropagation(); dragging.value = false
  if (!props.canvasId || !host.value) return
  if (!blank(event.target)) { error.value = t('panels.file.dropOnCanvas'); return }
  const incoming = readFileTransfer(event.dataTransfer)
  if (incoming.error) { error.value = t(incoming.error === 'folders' ? 'terminal.upload.foldersUnsupported' : 'panels.file.unreadableTransfer'); return }
  const bounds = host.value.getBoundingClientRect(), target = targetAt(event.clientX - bounds.left, event.clientY - bounds.top)
  if (target) await upload(incoming.files, target)
}
async function upload(files: File[], target: Target) {
  const rejected = admission(files)
  if (rejected) { error.value = t(rejected); return }
  const file = files[0]!, request = current = new AbortController()
  error.value = ''; progress.value = { name: file.name, canvasId: target.canvasId, canvasName: target.canvasName }
  try {
    requireCurrentApi(target.context)
    const query = new URLSearchParams({ filename: file.name, size: String(file.size),
      x: String(Math.max(-1e7, Math.min(1e7, target.position.x))), y: String(Math.max(-1e7, Math.min(1e7, target.position.y))) })
    await api(`/api/canvases/${segment(target.canvasId)}/files?${query}`, { method: 'POST', body: file,
      headers: { 'Content-Type': 'application/octet-stream' }, signal: request.signal }, target.context)
  } catch (reason) {
    if (!request.signal.aborted && !target.context.signal.aborted) error.value = reason instanceof Error ? reason.message : t('panels.file.addFailed')
  } finally { if (current === request) { current = undefined; progress.value = undefined } }
}
const fileDialog = useFileDialog({ multiple: false, reset: true })
let selection: Target | undefined
function chooseFiles() {
  if (!props.canvasId || !host.value) return
  if (current) { error.value = t('panels.file.uploadBusy'); return }
  const bounds = host.value.getBoundingClientRect(), viewport = props.getViewport()
  selection = targetAt(bounds.width / 2 - 160 * viewport.zoom, bounds.height / 2 - 120 * viewport.zoom)
  fileDialog.open()
}
fileDialog.onChange(files => {
  if (!files?.length) return
  const target = selection; selection = undefined
  if (!target || target.context.signal.aborted) return
  void upload([...files], target)
})
fileDialog.onCancel(() => { selection = undefined })
defineExpose({ chooseFiles, uploading: computed(() => !!progress.value) })
watch(apiRevision, () => { cancel(); selection = undefined; error.value = '' })
useEventListener(document, ['dragover', 'drop'], preventNavigation)
useEventListener(document, ['drop', 'dragend'], clearDrag, { capture: true })
useEventListener(window, 'blur', clearDrag)
useEventListener(host, ['dragenter', 'dragover'], track, { capture: true })
useEventListener(host, ['dragenter', 'dragover'], over)
useEventListener(host, 'dragleave', leave)
useEventListener(host, 'drop', drop)
onBeforeUnmount(cancel)
</script>

<template>
  <div ref="marker" class="canvas-file-drop-layer">
    <div v-if="dragging" class="canvas-file-drop-mask"><Icon name="file" :size="23" /><span>{{ t('panels.file.dropToAdd') }}</span></div>
    <div v-if="progress || error" class="canvas-file-transfer">
      <template v-if="progress">
        <div role="status"><span class="canvas-file-transfer-name">{{ progress.name }}<small v-if="progress.canvasId !== canvasId">{{ t('panels.file.uploadingTo', { name: progress.canvasName }) }}</small></span><UButton color="neutral" variant="ghost" size="xs" :aria-label="t('terminal.upload.cancel')" @click="cancel"><Icon name="close" :size="13" /></UButton></div>
        <UProgress size="xs" color="neutral" :aria-label="t('panels.file.adding')" />
      </template>
      <div v-if="error" role="alert"><span class="canvas-file-transfer-name">{{ error }}</span><UButton color="neutral" variant="ghost" size="xs" :aria-label="t('common.close')" @click="error = ''"><Icon name="close" :size="13" /></UButton></div>
    </div>
  </div>
</template>

<style scoped>
.canvas-file-drop-layer{position:absolute;inset:0;z-index:7;pointer-events:none}
.canvas-file-drop-mask{position:absolute;inset:12px;display:flex;align-items:center;justify-content:center;gap:10px;border:1px solid #d5aa8699;border-radius:10px;background:#171c2570;color:#e8c5a7;font-size:13px}
.canvas-file-transfer{position:absolute;left:50%;bottom:56px;translate:-50% 0;width:min(340px,calc(100% - 32px));padding:7px 10px;border:1px solid #424b58;border-radius:8px;background:#242a34f5;color:#bec9d8;box-shadow:0 5px 24px #0004;pointer-events:auto;font-size:11px}
.canvas-file-transfer>div{display:flex;align-items:center;gap:8px;min-width:0;margin-bottom:3px}.canvas-file-transfer-name{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.canvas-file-transfer-name small{display:block;color:#8c99ab;font-size:10px}
</style>
