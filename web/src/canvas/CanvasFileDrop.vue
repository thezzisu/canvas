<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useEventListener, useFileDialog } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import { apiUpload, apiContext, apiRevision, requireCurrentApi, segment } from '../api/api'
import { hasFileTransfer, readFileTransfer } from '../lib/browser-file-input'
import Icon from '../components/Icon.vue'
import UploadProgress from '../components/UploadProgress.vue'

const props = defineProps<{
  canvasId?: string
  canvasName?: string
  getViewport: () => { x: number; y: number; zoom: number }
}>()
const { t } = useI18n()
const marker = ref<HTMLElement>()
const dragging = ref(false)
const progress = ref<{
  name: string
  canvasId: string
  canvasName: string
  transferred: number
  total: number
}>()
const progressLabel = computed(() =>
  progress.value?.total && progress.value.transferred < progress.value.total
    ? `${Math.floor((progress.value.transferred / progress.value.total) * 100)}%`
    : t('panels.file.adding'),
)
const error = ref('')
const host = computed(() => marker.value?.parentElement)
let current: AbortController | undefined
const blank = (target: EventTarget | null) =>
  target instanceof Element &&
  !target.closest(
    '.vue-flow__node,.vue-flow__minimap,.canvas-toolbar,.vue-flow__controls,button,input,textarea',
  )
// Observe before child editors stop bubbling, but never claim their drop.
function track(event: DragEvent) {
  if (hasFileTransfer(event.dataTransfer))
    dragging.value = !!props.canvasId && !current && blank(event.target)
}
function over(event: DragEvent) {
  if (!hasFileTransfer(event.dataTransfer) || !blank(event.target)) return
  event.preventDefault()
  event.stopPropagation()
  if (event.dataTransfer)
    event.dataTransfer.dropEffect = props.canvasId && !current ? 'copy' : 'none'
}
function clearDrag() {
  dragging.value = false
}
function preventNavigation(event: DragEvent) {
  if (!hasFileTransfer(event.dataTransfer) || event.defaultPrevented) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'
}
function leave(event: DragEvent) {
  if (!(event.relatedTarget instanceof Node) || !host.value?.contains(event.relatedTarget))
    dragging.value = false
}
function cancel() {
  current?.abort()
  current = undefined
  progress.value = undefined
  dragging.value = false
}
function admission(files: File[]) {
  if (files.some((file) => file.webkitRelativePath)) return 'terminal.upload.foldersUnsupported'
  if (files.length > 1) return 'panels.file.singleOnly'
  if (!files.length) return 'panels.file.unreadableTransfer'
  return current ? 'panels.file.uploadBusy' : undefined
}
type Target = {
  canvasId: string
  canvasName: string
  context: ReturnType<typeof apiContext>
  position: { x: number; y: number }
}
function targetAt(x: number, y: number): Target | undefined {
  if (!props.canvasId) return
  const viewport = props.getViewport()
  return {
    canvasId: props.canvasId,
    canvasName: props.canvasName || '',
    context: apiContext(),
    position: { x: (x - viewport.x) / viewport.zoom, y: (y - viewport.y) / viewport.zoom },
  }
}
async function drop(event: DragEvent) {
  if (
    !hasFileTransfer(event.dataTransfer) ||
    event.defaultPrevented ||
    (event.target instanceof Element && event.target.closest('.terminal-card,.note-editor-content'))
  )
    return
  event.preventDefault()
  event.stopPropagation()
  dragging.value = false
  if (!props.canvasId || !host.value) return
  if (!blank(event.target)) {
    error.value = t('panels.file.dropOnCanvas')
    return
  }
  const incoming = readFileTransfer(event.dataTransfer)
  if (incoming.error) {
    error.value = t(
      incoming.error === 'folders'
        ? 'terminal.upload.foldersUnsupported'
        : 'panels.file.unreadableTransfer',
    )
    return
  }
  const bounds = host.value.getBoundingClientRect(),
    target = targetAt(event.clientX - bounds.left, event.clientY - bounds.top)
  if (target) await upload(incoming.files, target)
}
async function upload(files: File[], target: Target) {
  const rejected = admission(files)
  if (rejected) {
    error.value = t(rejected)
    return
  }
  const file = files[0]!,
    request = (current = new AbortController())
  error.value = ''
  progress.value = {
    name: file.name,
    canvasId: target.canvasId,
    canvasName: target.canvasName,
    transferred: 0,
    total: file.size,
  }
  try {
    requireCurrentApi(target.context)
    const query = new URLSearchParams({
      filename: file.name,
      size: String(file.size),
      x: String(Math.max(-1e7, Math.min(1e7, target.position.x))),
      y: String(Math.max(-1e7, Math.min(1e7, target.position.y))),
    })
    await apiUpload(
      `/api/canvases/${segment(target.canvasId)}/files?${query}`,
      file,
      (loaded) => {
        if (current === request && progress.value) progress.value.transferred = loaded
      },
      request.signal,
      target.context,
    )
  } catch (reason) {
    if (!request.signal.aborted && !target.context.signal.aborted)
      error.value = reason instanceof Error ? reason.message : t('panels.file.addFailed')
  } finally {
    if (current === request) {
      current = undefined
      progress.value = undefined
    }
  }
}
const fileDialog = useFileDialog({ multiple: false, reset: true })
let selection: Target | undefined
function chooseFiles() {
  if (!props.canvasId || !host.value) return
  if (current) {
    error.value = t('panels.file.uploadBusy')
    return
  }
  const bounds = host.value.getBoundingClientRect(),
    viewport = props.getViewport()
  selection = targetAt(
    bounds.width / 2 - 160 * viewport.zoom,
    bounds.height / 2 - 120 * viewport.zoom,
  )
  fileDialog.open()
}
fileDialog.onChange((files) => {
  if (!files?.length) return
  const target = selection
  selection = undefined
  if (!target || target.context.signal.aborted) return
  void upload([...files], target)
})
fileDialog.onCancel(() => {
  selection = undefined
})
defineExpose({ chooseFiles, uploading: computed(() => !!progress.value) })
watch(apiRevision, () => {
  cancel()
  selection = undefined
  error.value = ''
})
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
    <div v-if="dragging" class="canvas-file-drop-mask">
      <Icon name="file" :size="23" /><span>{{ t('panels.file.dropToAdd') }}</span>
    </div>
    <UploadProgress
      v-if="progress || error"
      class="canvas-file-transfer"
      :name="progress?.name || ''"
      :status="error || progressLabel"
      :transferred="progress?.transferred"
      :total="progress?.total"
      :active="!!progress"
      :failed="!!error"
      @cancel="progress ? cancel() : (error = '')"
    >
      <small v-if="progress && progress.canvasId !== canvasId">{{
        t('panels.file.uploadingTo', { name: progress.canvasName })
      }}</small>
    </UploadProgress>
  </div>
</template>

<style scoped>
.canvas-file-drop-layer {
  position: absolute;
  inset: 0;
  z-index: 7;
  pointer-events: none;
}
.canvas-file-drop-mask {
  position: absolute;
  inset: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  border: 1px solid #d5aa8699;
  border-radius: 10px;
  background: #171c2570;
  color: #e8c5a7;
  font-size: 13px;
}
.canvas-file-transfer {
  position: absolute;
  left: 50%;
  bottom: 56px;
  translate: -50% 0;
  width: min(340px, calc(100% - 32px));
  pointer-events: auto;
}
.canvas-file-transfer small {
  display: block;
  color: #8c99ab;
  font-size: 10px;
}
</style>
