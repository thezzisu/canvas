<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { NodeProps } from '@vue-flow/core'
import { NodeResizeControl } from '@vue-flow/node-resizer'
import UDropdownMenu, { type DropdownMenuItem } from '@nuxt/ui/components/DropdownMenu.vue'
import type { FileData } from '../types'
import Icon from './Icon.vue'
import CardPreview from './CardPreview.vue'
import { BinaryFileError, readTextPreview } from '../text-preview'
import { filePreview } from '../file-preview'
import TextPreview from './TextPreview.vue'
import TextPreviewActions from './TextPreviewActions.vue'
import MediaPreview from './MediaPreview.vue'
import { isMarkdownFile } from '../markdown'
import { activeInstance } from '../instances'
import { downloadMedia, useMediaUrl } from '../media'
import { reportDownloadError } from '../downloads'
import { apiFetch } from '../api'
import { copyCanvasFile, fileReference } from '../file-transfer'
import { writeFileReference } from '../file-reference'
import { cutoutPosition, cutoutWidth, useCompactHeader } from '../display-cutout'
import { useFileView } from '../file-view'
import { usePointerDismiss } from '../pointer-dismiss'

const { t, n } = useI18n()

const props = withDefaults(defineProps<Pick<NodeProps<FileData>, 'id' | 'data'> & { selected?: boolean }>(), { selected: false })
const binary = ref(false)
const preview = computed(() => binary.value ? 'file' : filePreview(props.data.asset))
watch(() => props.data.assetId, () => { binary.value = false })
const mobilePreview = computed(() => !!props.data.mobile && !props.data.focus)
const header = ref<HTMLElement>()
const compact = useCompactHeader(computed(() => props.data.mobile && props.data.focus ? header.value : undefined))
const markdown = computed(() => preview.value === 'text' && isMarkdownFile(props.data.asset.filename))
const { rendered, wrap, reading, remember } = useFileView(props.data.instanceId, props.data.canvasId, props.id, markdown.value, props.data.canPersistView)
const menuOpen = ref(false), menuTrigger = ref<HTMLButtonElement>()
const menuDismiss = usePointerDismiss(menuOpen, menuTrigger)
const menu = computed<DropdownMenuItem[]>(() => [
  ...(markdown.value && compact.value ? [{ label: t('panels.preview.source'), type: 'checkbox' as const, checked: !rendered.value, onUpdateChecked: (checked: boolean) => { rendered.value = !checked } }] : []),
  ...(preview.value === 'text' && (!markdown.value || !rendered.value) ? [{ label: t('panels.preview.wrap'), type: 'checkbox' as const, checked: wrap.value, onUpdateChecked: (checked: boolean) => { wrap.value = checked } }] : []),
  { label: t('panels.file.download'), onSelect: download },
  { label: t('fileTransfer.copy'), onSelect: copyFile },
  { label: t('app.addToOtherCanvas'), onSelect: () => props.data.onAction?.('add', props.id) },
  { label: t('panels.file.remove'), onSelect: () => props.data.onRemove(props.id) },
  { label: t('common.settings'), onSelect: () => props.data.onAction?.('settings', props.id) },
])
const sourceInstance = { id: activeInstance.value.id, base: activeInstance.value.base }
const pdfPreview = navigator.pdfViewerEnabled
const path = computed(() => `/api/files/${encodeURIComponent(props.data.assetId)}`)
const { url, error: ticketError, retry: retryTicket } = useMediaUrl(() => ['image', 'audio', 'video', 'pdf'].includes(preview.value) ? path.value : undefined)
const imageFailed = ref(false)
watch(() => props.data.assetId, () => { imageFailed.value = false })
function download() { void downloadMedia(path.value, props.data.asset.filename).catch(reportDownloadError) }
const fileBody = ref<HTMLElement>()
const text = ref('')
const textLoading = ref(false)
const textError = ref<string | Error>('')
const truncated = ref(false)
const copyFeedback = ref('')
let copyTimer: ReturnType<typeof setTimeout> | undefined
function copyFile() {
  clearTimeout(copyTimer)
  try { copyCanvasFile(props.data.asset, sourceInstance); copyFeedback.value = 'fileTransfer.copied' }
  catch (error) { copyFeedback.value = error instanceof Error ? error.message : 'fileTransfer.failed' }
  copyTimer = setTimeout(() => { copyFeedback.value = '' }, 2200)
}
function dragFile(event: DragEvent) {
  if (!writeFileReference(event.dataTransfer, fileReference(props.data.assetId, sourceInstance))) event.preventDefault()
  event.stopPropagation()
}
let visibility: IntersectionObserver | undefined
let request: AbortController | undefined
async function loadText() {
  if (preview.value !== 'text') return
  request?.abort()
  const current = request = new AbortController()
  textLoading.value = true; textError.value = ''; truncated.value = false
  try {
    const result = await readTextPreview(path.value, props.data.asset.size, current.signal, apiFetch)
    if (request !== current || current.signal.aborted) return
    text.value = result.text; truncated.value = result.truncated
  } catch (reason) {
    if (request === current && !current.signal.aborted) {
      if (reason instanceof BinaryFileError) binary.value = true
      else textError.value = reason instanceof Error ? reason : 'panels.file.unreadable'
    }
  } finally { if (request === current) textLoading.value = false }
}
watch([fileBody, () => props.data.assetId, () => preview.value], ([element, _id, preview]) => {
  request?.abort(); request = undefined; visibility?.disconnect()
  text.value = ''; textError.value = ''; truncated.value = false; textLoading.value = preview === 'text'
  if (!element || preview !== 'text') return
  visibility = new IntersectionObserver(entries => {
    if (!entries.some(entry => entry.isIntersecting)) return
    visibility?.disconnect()
    void loadText()
  }, { rootMargin: '200px' })
  visibility.observe(element)
}, { immediate: true, flush: 'post' })
onBeforeUnmount(() => { clearTimeout(copyTimer); request?.abort(); visibility?.disconnect() })
const size = computed(() => {
  const bytes = props.data.asset.size
  if (bytes < 1024) return `${n(bytes)} B`
  const unit = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${n(bytes / 1024 ** unit, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${['B', 'KiB', 'MiB', 'GiB'][unit]}`
})
</script>

<template>
  <template v-if="!data.mobile && !data.focus">
    <NodeResizeControl v-for="position in (['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const)" :key="position" :node-id="id" :position="position" :min-width="240" :min-height="160" :max-width="4000" :max-height="3000" @resize-start="data.onLayoutStart" @resize-end="event => data.onResize(id, event.params.width, event.params.height, event.params.x, event.params.y)" />
  </template>
  <article class="file-card" :class="{ 'mobile-card-preview': mobilePreview, 'card-focused': data.focus }" :data-asset-id="data.assetId" :data-preview-kind="preview">
    <header ref="header" class="file-header drag-handle" :class="{ 'cutout-header': data.focus }" :data-cutout-position="data.focus && cutoutWidth > 0 ? cutoutPosition : undefined" :style="data.focus ? { '--cutout-width': `calc(${cutoutWidth}px / var(--ui-zoom))` } : undefined" :inert="mobilePreview || undefined" :aria-hidden="mobilePreview || undefined">
      <span class="file-icon" :class="{ 'cutout-status': data.focus }"><Icon name="file" :size="13" /></span>
      <span class="file-title" :class="{ 'cutout-title': data.focus }" :title="data.asset.filename">{{ data.asset.filename }}</span>
      <span v-if="!data.focus" class="file-size">{{ size }}</span>
      <div class="file-actions" :class="{ 'cutout-actions': data.focus }">
      <TextPreviewActions v-if="preview === 'text' && (!data.focus || markdown && !compact)" v-model:rendered="rendered" v-model:wrap="wrap" :filename="data.asset.filename" :hide-wrap="data.focus" />
      <button v-if="!data.focus" type="button" class="file-action file-copy nodrag" draggable="true" :title="t(copyFeedback || 'fileTransfer.copyOrDrag')" :aria-label="t('fileTransfer.copy')" @pointerdown.stop @click.stop="copyFile" @dragstart="dragFile"><Icon :name="copyFeedback === 'fileTransfer.copied' ? 'check' : 'copy'" :size="14" /></button>
      <button v-if="!data.focus" type="button" class="file-action nodrag" :title="t('app.addToOtherCanvas')" :aria-label="t('app.addToOtherCanvas')" @click.stop="data.onAction?.('add', id)"><Icon name="layers" :size="14" /></button>
      <span class="sr-only" role="status">{{ copyFeedback ? t(copyFeedback) : '' }}</span>
      <button v-if="!data.focus || !markdown && !compact" type="button" class="file-action nodrag" @click.stop="download" :title="t('panels.file.download')" :aria-label="t('panels.file.download')" @pointerdown.stop><Icon name="download" :size="14" /></button>
      <template v-if="data.focus">
        <UDropdownMenu v-model:open="menuOpen" :modal="false" :items="menu" :portal="false" :content="{ align: 'end', ...menuDismiss }" :ui="{ content: 'card-action-menu' }">
          <button ref="menuTrigger" type="button" class="file-action file-more nodrag" :aria-label="t('common.more')" :title="t('common.more')"><Icon name="more" :size="17" /></button>
        </UDropdownMenu>
        <button type="button" class="file-action nodrag" :title="t('common.returnToCanvas')" :aria-label="t('common.returnToCanvas')" @click.stop="data.onAction?.('unfocus', id)"><Icon name="collapse" :size="17" /></button>
      </template>
      <button v-else class="file-action nodrag" :title="t('panels.file.remove')" :aria-label="t('panels.file.remove')" @click.stop="data.onRemove(id)"><Icon name="close" :size="14" /></button>
      </div>
    </header>
    <div ref="fileBody" class="file-body nodrag nopan" :inert="mobilePreview || undefined" :aria-hidden="mobilePreview || undefined" @pointerdown.stop @dblclick.stop>
      <div v-if="(['image', 'audio', 'video'].includes(preview) || preview === 'pdf' && pdfPreview) && !url" class="file-text-status" :role="ticketError ? 'alert' : 'status'">
        <template v-if="ticketError"><span>{{ t('panels.preview.unavailable') }}</span><button type="button" @click="retryTicket">{{ t('common.retry') }}</button></template>
        <template v-else><span class="spinner" />{{ t('common.loading') }}</template>
      </div>
      <img v-else-if="preview === 'image' && url && !imageFailed" class="file-image" :src="url" :alt="data.asset.filename" draggable="false" loading="lazy" @error="imageFailed = true" />
      <MediaPreview v-else-if="(preview === 'audio' || preview === 'video') && url" :key="data.assetId" :kind="preview" :src="url" :title="data.asset.filename" :read-only="mobilePreview" @download="download" />
      <div v-else-if="preview === 'text'" class="file-text-body nowheel" @wheel.stop>
        <div v-if="textLoading" class="file-text-status" role="status"><span class="spinner" /> {{ t('common.loading') }}</div>
        <div v-else-if="textError" class="file-text-status" role="alert"><span>{{ textError instanceof Error ? textError.message : t(textError) }}</span><button type="button" @click="loadText">{{ t('common.retry') }}</button></div>
        <TextPreview v-else :text="text" :filename="data.asset.filename" :rendered="rendered" :wrap="wrap" :reading="reading" :read-only="mobilePreview" @reading="remember" />
        <div v-if="truncated" class="file-text-truncated"><span>{{ t('panels.preview.truncated') }}</span><button type="button" @click="download">{{ t('panels.file.downloadOriginal') }}</button></div>
      </div>
      <iframe v-else-if="preview === 'pdf' && pdfPreview && url" class="file-preview nowheel" :src="url" :title="data.asset.filename" loading="lazy" referrerpolicy="no-referrer" />
      <button v-else type="button" class="file-download" @click="download" :aria-label="t('panels.file.downloadNamed', { name: data.asset.filename })"><Icon name="file" :size="42" /><span>{{ data.asset.filename }}</span></button>
    </div>
    <CardPreview v-if="mobilePreview" :label="t('common.openCard', { name: data.asset.filename })" @open="data.onAction?.('focus', id)" />
  </article>
</template>

<style scoped>
.file-card { position:relative; height: 100%; display: flex; flex-direction: column; overflow: hidden; border: 1px solid #3a3d46; border-radius: 7px; background: #1b1d23; box-shadow: 0 5px 18px #0003; }
.file-header { display: flex; align-items: center; gap: 7px; height: 30px; flex: 0 0 30px; padding: 0 7px 0 10px; color: #a9b0be; cursor: grab; border-bottom: 1px solid #343740; }
.file-title { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: #e0e3ea; }
.file-size { font-size: 10px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.file-icon,.file-actions{display:flex;align-items:center;flex:none}.file-actions{gap:0}
.file-action { display: inline-flex; justify-content: center; align-items: center; flex: 0 0 23px; width: 23px; height: 23px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: #a9b0be; cursor: pointer; }
.file-action:hover { color: #fff; background: #ffffff12; }
.file-copy{cursor:grab}.file-copy:active{cursor:grabbing}
.file-action:focus-visible, .file-download:focus-visible { outline: 2px solid #8c9ef8; outline-offset: -2px; }
.file-body { flex: 1; min-height: 0; display: flex; overflow: hidden; }
.file-image { width: 100%; height: 100%; object-fit: contain; }
.file-preview { border: 0; width: 100%; height: 100%; background: #fff; color-scheme: light; }
.file-text-body { display: flex; flex-direction: column; width: 100%; min-width: 0; min-height: 0; background: #14191f; }
.file-text-status { display: flex; flex: 1; align-items: center; justify-content: center; gap: 8px; padding: 12px; color: #8b98a9; font-size: 11px; }
.file-text-status button { color: #d4ac8e; font-size: 11px; }
.file-text-truncated { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; flex: 0 0 auto; padding: 7px 10px; border-top: 1px solid #303947; font-size: 10px; color: #7f8da1; }
.file-text-truncated button { flex-shrink: 0; color: #c7aa93; text-decoration: none; }
.file-download { display: flex; flex: 1; min-width: 0; align-items: center; justify-content: center; flex-direction: column; gap: 14px; padding: 24px; color: #a9b0be; text-decoration: none; }
.file-download:hover { color: #e0e3ea; background: #ffffff04; }
.file-download span { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.card-focused .file-header{height:calc(44px + var(--mobile-safe-top,0px));flex-basis:calc(44px + var(--mobile-safe-top,0px));padding:var(--mobile-safe-top,0px) 0 0;gap:0;cursor:default}
.card-focused .file-title{font-size:13px;margin-inline:6px}
.card-focused .file-icon{width:44px;height:44px;justify-content:center}
.card-focused .file-actions{gap:0}
.card-focused :deep(.text-preview-actions){gap:0}
.card-focused .file-action{width:44px;height:44px;flex-basis:44px}
.card-focused{--header-action-size:44px}
.canvas-fullscreen .card-focused .file-header{height:44px;flex-basis:44px;padding-top:0}

</style>
