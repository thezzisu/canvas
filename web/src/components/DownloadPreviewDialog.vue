<script setup lang="ts">
import UIcon from '@nuxt/ui/components/Icon.vue'
import { useI18n } from 'vue-i18n'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useElementSize } from '@vueuse/core'
import { headerShortcuts } from '../header-capacity'
import UModal from './CanvasModal.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UDropdownMenu, { type DropdownMenuItem } from '@nuxt/ui/components/DropdownMenu.vue'
import { DialogTitle } from 'reka-ui'
import Icon from './Icon.vue'
import FileIcon from './FileIcon.vue'
import ImagePreview from './ImagePreview.vue'
import MediaPreview from './MediaPreview.vue'
import TextPreview from './TextPreview.vue'
import TextPreviewActions from './TextPreviewActions.vue'
import { downloadPreview, downloadPreviewCount, dismissDownloadPreview } from '../downloads'
import { BinaryFileError, readTextPreview } from '../text-preview'
import { downloadMedia, useMediaUrl } from '../media'
import { reportDownloadError } from '../downloads'
import { apiFetch } from '../api'
import { useMobileViewport } from '../viewport'
import { cutoutPosition, cutoutWidth } from '../display-cutout'
import { useTextPreviewActions } from '../text-preview-actions'
import { useSourcePreview } from '../source-preview'
import { useMobileLayout } from '../mobile-layout'
import { usePointerDismiss } from '../pointer-dismiss'

const { t, n } = useI18n()

const pdfPreview = navigator.pdfViewerEnabled
const { url: previewUrl, error: ticketError, retry: retryTicket } = useMediaUrl(() => downloadPreview.value?.preview === 'text' ? undefined : downloadPreview.value?.url)
const text = ref('')
const loading = ref(false)
const error = ref<string | Error>('')
const truncated = ref(false)
const expanded = ref(false)
const rendered = ref(true), wrap = ref(false), formatted = ref(false), highlighted = ref(true)
const sitePreview = useSourcePreview()
const previewBusy = sitePreview.busy
function previewSite() { const item = downloadPreview.value; if (item?.sourcePreview) void sitePreview.open(item.url, item.filename) }
const menuOpen = ref(false), menuTrigger = ref<InstanceType<typeof UButton>>()
const menuDismiss = usePointerDismiss(menuOpen, menuTrigger)
const mobile = useMobileLayout()
const imageSize = ref<{ width: number; height: number }>()
const preparing = computed(() => ['image', 'video'].includes(downloadPreview.value?.preview || '') &&
  !imageSize.value && !error.value && !ticketError.value)
const { viewport } = useMobileViewport(ref(true))
const mobileHeader = computed(() => mobile.value || viewport.value.width <= 600)
function download() { const preview = downloadPreview.value; if (preview) void downloadMedia(preview.url, preview.filename).catch(reportDownloadError) }
const textActions = useTextPreviewActions(() => downloadPreview.value?.filename || '', { rendered, wrap, formatted, highlighted }, {
  sourcePreview: () => downloadPreview.value?.sourcePreview, busy: previewBusy, preview: previewSite,
})
const textShortcuts = computed(() => downloadPreview.value?.preview === 'text' && !loading.value && !error.value ? textActions.value.map(item => item.slot!) : [])
const actions = ref<HTMLElement>()
const { width: actionsWidth } = useElementSize(computed(() => mobileHeader.value ? actions.value : undefined))
const available = computed(() => headerShortcuts(actionsWidth.value, ['download', ...textShortcuts.value], false))
const showShortcut = (key: string) => !mobileHeader.value || available.value.has(key)
const menu = computed<DropdownMenuItem[]>(() => [
  ...(downloadPreview.value?.preview === 'text' ? textActions.value : []),
  { label: t('panels.file.download'), icon: 'i-lucide-download', onSelect: download },
  { label: t(expanded.value ? 'panels.preview.exitFullscreen' : 'panels.preview.fullscreen'), icon: expanded.value ? 'i-lucide-minimize' : 'i-lucide-maximize', onSelect: () => { expanded.value = !expanded.value } },
  ...(expanded.value ? [{ label: t('panels.preview.close'), icon: 'i-lucide-x', onSelect: dismissDownloadPreview }] : []),
])
const modalStyle = computed(() => {
  const visible = viewport.value, narrow = visible.width <= 600
  let width = Math.min(1000, visible.width - (narrow ? 12 : 32))
  let height = Math.min(800, visible.height - (narrow ? 24 : 48))
  if (['image', 'video'].includes(downloadPreview.value?.preview || '') && imageSize.value) {
    const image = imageSize.value
    const chrome = downloadPreview.value?.preview === 'image' ? 86 : 46
    const scale = Math.min(1, Math.max(1, width - 2) / image.width, Math.max(1, height - chrome) / image.height)
    width = Math.min(width, Math.max(300, image.width * scale + 2))
    height = Math.min(height, Math.max(126, image.height * scale + chrome))
  } else if (['image', 'video'].includes(downloadPreview.value?.preview || '') && (error.value || ticketError.value)) {
    width = Math.min(width, 480)
    height = Math.min(height, 200)
  } else if (downloadPreview.value?.preview === 'audio') {
    width = Math.min(width, 560)
    height = Math.min(height, 160)
  }
  return { '--preview-width': `${Math.max(1, width)}px`, '--preview-height': `${Math.max(1, height)}px`,
    '--preview-viewport-width': `${visible.width}px`, '--preview-viewport-height': `${visible.height}px`,
    '--preview-left': `${visible.left}px`, '--preview-top': `${visible.top}px` }
})
let request: AbortController | undefined

async function loadText() {
  const preview = downloadPreview.value
  if (!preview || preview.preview !== 'text') return
  request?.abort()
  const current = request = new AbortController()
  loading.value = true; error.value = ''
  try {
    const result = await readTextPreview(`${preview.url}${preview.url.includes('?') ? '&' : '?'}preview=1`, preview.size, current.signal, apiFetch)
    if (request !== current || current.signal.aborted) return
    text.value = result.text; truncated.value = result.truncated
  } catch (reason) {
    if (request === current && !current.signal.aborted) {
      if (reason instanceof BinaryFileError) { download(); dismissDownloadPreview() }
      else error.value = reason instanceof Error ? reason : 'panels.preview.unavailable'
    }
  } finally { if (request === current) loading.value = false }
}
watch(downloadPreview, preview => {
  request?.abort(); request = undefined
  text.value = ''; error.value = ''; truncated.value = false
  expanded.value = false; imageSize.value = undefined
  rendered.value = true; wrap.value = false; formatted.value = false; highlighted.value = true
  loading.value = preview?.preview === 'image' || preview?.preview === 'video'
  if (preview?.preview === 'text') void loadText()
}, { immediate: true })
function imageLoaded(id: string, width: number, height: number) {
  if (id !== downloadPreview.value?.id) return
  loading.value = false
  imageSize.value = { width, height }
}
function mediaFailed() { loading.value = false; error.value = 'panels.preview.mediaUnavailable' }
function mediaLoaded(width: number, height: number) {
  loading.value = false
  imageSize.value = { width, height }
}
function imageFailed(id: string) {
  if (id !== downloadPreview.value?.id) return
  loading.value = false; error.value = 'panels.preview.unavailable'
}
function openChanged(open: boolean) { if (!open) dismissDownloadPreview() }
function preventReturnFocus(event: Event) { event.preventDefault() }
function stopEscape(event: Event) {
  event.stopPropagation()
  if (expanded.value) { event.preventDefault(); expanded.value = false }
}
const modalContent = computed(() => ({ style: modalStyle.value, 'aria-busy': preparing.value, onCloseAutoFocus: preventReturnFocus, onEscapeKeyDown: stopEscape }))
onBeforeUnmount(() => request?.abort())
</script>

<template>
  <UModal v-if="downloadPreview" :key="downloadPreview.id" :open="true" :title="downloadPreview.filename" :fullscreen="expanded" :transition="false"
    :close="false" :content="modalContent"
    :ui="{ content: `download-preview-modal${preparing ? ' download-preview-preparing' : ''}${expanded ? ' download-preview-fullscreen' : ''}${mobileHeader ? ' download-preview-mobile' : ''}`, header: 'download-preview-header-slot', body: 'download-preview-body' }"
    @update:open="openChanged">
    <template #header>
      <header class="download-preview-header" :class="{ 'cutout-header': mobileHeader && expanded }" :data-cutout-position="mobileHeader && expanded && cutoutWidth > 0 ? cutoutPosition : undefined" :style="{ '--cutout-width': `calc(${cutoutWidth}px / var(--ui-zoom))` }">
        <span v-if="preparing" class="download-preview-pending" role="status"><UIcon name="i-lucide-loader-circle" class="spinner size-3.5 shrink-0 motion-safe:animate-spin" />{{ t('common.loading') }}</span>
        <DialogTitle class="download-preview-title" :class="{ 'cutout-title': mobileHeader && expanded, 'sr-only': preparing }"><FileIcon class="me-2" :name="downloadPreview.filename" :size="16" />{{ downloadPreview.filename }}<span v-if="downloadPreviewCount > 1" class="download-preview-count" :aria-label="t('panels.preview.remaining', downloadPreviewCount - 1)"> +{{ n(downloadPreviewCount - 1) }}</span></DialogTitle>
        <div ref="actions" class="download-preview-actions" :class="{ 'cutout-actions': mobileHeader && expanded }" :style="{ '--header-actions-width': `${(textShortcuts.length + 3) * 44}px` }">
          <template v-for="key in textShortcuts" :key="key"><TextPreviewActions v-if="showShortcut(key)" :only="key" :filename="downloadPreview.filename" v-model:rendered="rendered" v-model:wrap="wrap" v-model:formatted="formatted" v-model:highlighted="highlighted" :source-preview="downloadPreview.sourcePreview" :preview-busy="previewBusy" @preview="previewSite" /></template>
          <UButton v-if="!preparing && showShortcut('download')" type="button" color="neutral" variant="ghost" class="download-preview-button download-preview-download" :aria-label="t('panels.file.download')" :title="t('panels.file.download')" @click="download"><Icon name="download" :size="16" /></UButton>
          <UDropdownMenu v-if="mobileHeader && !preparing" v-model:open="menuOpen" :modal="false" :items="menu" :content="{ align: 'end', ...menuDismiss }" :ui="{ content: 'card-action-menu download-preview-menu min-w-[160px]' }">
            <UButton ref="menuTrigger" type="button" color="neutral" variant="ghost" class="download-preview-button" :aria-label="t('common.more')" :title="t('common.more')"><Icon name="more" :size="17" /></UButton>
          </UDropdownMenu>
          <UButton v-else-if="!preparing" type="button" color="neutral" variant="ghost" class="download-preview-button download-preview-expand" :aria-label="t(expanded ? 'panels.preview.exitFullscreen' : 'panels.preview.fullscreen')" :title="t(expanded ? 'panels.preview.exitFullscreen' : 'panels.preview.fullscreen')" :aria-pressed="expanded" @click="expanded = !expanded"><Icon :name="expanded ? 'collapse' : 'expand'" :size="16" /></UButton>
          <UButton type="button" color="neutral" variant="ghost" class="download-preview-button download-preview-close" :aria-label="t(mobile && expanded ? 'panels.preview.exitFullscreen' : 'panels.preview.close')" :title="t(mobile && expanded ? 'panels.preview.exitFullscreen' : 'panels.preview.close')" @click="mobile && expanded ? expanded = false : dismissDownloadPreview()"><Icon :name="mobile && expanded ? 'collapse' : 'close'" :size="17" /></UButton>
        </div>
      </header>
    </template>
    <template #body>
      <div class="download-preview-content" :inert="preparing || undefined" :aria-hidden="preparing || undefined" :data-download-id="downloadPreview.id" :data-preview-kind="downloadPreview.preview">
        <div v-if="ticketError && !previewUrl" class="download-preview-status" role="alert"><span>{{ t('panels.preview.unavailable') }}</span><UButton color="primary" variant="link" size="xs" @click="retryTicket">{{ t('common.retry') }}</UButton></div>
        <div v-else-if="loading || (downloadPreview.preview !== 'text' && !previewUrl)" class="download-preview-status" role="status"><UIcon name="i-lucide-loader-circle" class="spinner size-3.5 shrink-0 motion-safe:animate-spin" /> {{ t('common.loading') }}</div>
        <div v-if="error && downloadPreview.preview !== 'audio' && downloadPreview.preview !== 'video'" class="download-preview-status" role="alert"><span>{{ error instanceof Error ? error.message : t(error) }}</span><UButton v-if="downloadPreview.preview === 'text'" color="primary" variant="link" size="xs" @click="loadText">{{ t('common.retry') }}</UButton></div>
        <ImagePreview v-if="downloadPreview.preview === 'image' && previewUrl && !error" :key="downloadPreview.id" :id="downloadPreview.id" :src="previewUrl" :alt="downloadPreview.filename" @loaded="imageLoaded" @failed="imageFailed" />
        <MediaPreview v-else-if="(downloadPreview.preview === 'audio' || downloadPreview.preview === 'video') && previewUrl" :key="downloadPreview.id" :kind="downloadPreview.preview" :src="previewUrl" :title="downloadPreview.filename" @download="download" @loaded="mediaLoaded" @failed="mediaFailed" />
        <template v-else-if="downloadPreview.preview === 'pdf'">
          <iframe v-if="pdfPreview && previewUrl" class="download-preview-pdf" :src="previewUrl" :title="downloadPreview.filename" referrerpolicy="no-referrer" />
          <div v-else class="download-preview-status">{{ t('panels.preview.pdfUnavailable') }}</div>
        </template>
        <template v-else-if="downloadPreview.preview === 'text' && !loading && !error">
          <TextPreview :text="text" :filename="downloadPreview.filename" :rendered="rendered" :wrap="wrap" v-model:formatted="formatted" v-model:highlighted="highlighted" />
          <div v-if="truncated" class="download-preview-truncated">{{ t('panels.preview.truncated') }}</div>
        </template>
      </div>
    </template>
  </UModal>
</template>

<style>
.download-preview-modal{--preview-safe-top:var(--mobile-safe-top,var(--ui-safe-top));--preview-safe-bottom:var(--mobile-safe-bottom,var(--ui-safe-bottom));--preview-frame-width:var(--mobile-width,var(--preview-viewport-width));--preview-frame-height:var(--dialog-height);display:grid;grid-template-rows:auto minmax(0,1fr);gap:0;position:fixed;left:calc(var(--mobile-left,var(--preview-left)) + (var(--preview-frame-width) + var(--ui-safe-left) - var(--ui-safe-right))/2);top:calc(var(--dialog-top) + (var(--preview-frame-height) + var(--preview-safe-top) - var(--preview-safe-bottom))/2);translate:-50% -50%;width:min(var(--preview-width),calc(var(--preview-frame-width) - 12px - var(--ui-safe-left) - var(--ui-safe-right)));max-width:none;height:min(var(--preview-height),calc(var(--preview-frame-height) - 24px - var(--preview-safe-top) - var(--preview-safe-bottom)));max-height:none;overflow:auto;overscroll-behavior:contain;background:#191d23;border:1px solid #3b424c;box-shadow:0 16px 60px #0005}
/* Media stays mounted while the transparent loading row waits for intrinsic size. */
.download-preview-modal.download-preview-preparing{width:auto;height:auto;min-width:160px;overflow:visible;background:transparent;border-color:transparent;box-shadow:none}
.download-preview-preparing .download-preview-header{border:0;gap:8px}
.download-preview-preparing .download-preview-body{position:absolute;inset:0;visibility:hidden;pointer-events:none}
.download-preview-pending{display:flex;align-items:center;gap:8px;flex:1;font-size:13px;color:#d6dce5}
.download-preview-modal.download-preview-fullscreen{box-sizing:border-box;left:var(--mobile-left,var(--preview-left));top:var(--dialog-top);right:auto;bottom:auto;translate:none;width:var(--preview-frame-width);height:var(--preview-frame-height);max-width:none;max-height:none;border:0;border-radius:0;padding:var(--preview-safe-top) var(--ui-safe-right) var(--preview-safe-bottom) var(--ui-safe-left)}
.download-preview-header-slot{display:contents}
.download-preview-header{container-type:inline-size;--header-action-size:28px;display:flex;align-items:center;height:44px;min-height:44px;padding:0 8px 0 12px;gap:0;border-bottom:1px solid #343a43}
.download-preview-title{display:block;flex:1;min-width:0;font-size:13px;font-weight:500;letter-spacing:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#d6dce5}
.download-preview-count{font-size:10px;color:#8290a1;font-variant-numeric:tabular-nums}
.download-preview-actions{display:flex;flex:none;gap:0;align-items:center}
.download-preview-button{position:static;flex:none;display:flex;align-items:center;justify-content:center;width:var(--header-action-size);min-width:var(--header-action-size);height:var(--header-action-size);padding:0;color:#93a1b4;border-radius:5px}
.download-preview-button:hover{background:#ffffff08;color:#d4dfec}
.download-preview-mobile .download-preview-header{container-type:inline-size;--header-action-size:44px;padding:0}
.download-preview-mobile .download-preview-title{padding-left:12px}
.download-preview-mobile .download-preview-actions{min-width:0;justify-content:flex-end;width:min(var(--header-actions-width),max(88px,calc(100cqw - 88px)))}
.download-preview-modal{container-type:inline-size}
.canvas-fullscreen.has-display-cutout .download-preview-fullscreen.download-preview-mobile{padding-top:0}
.canvas-fullscreen.has-display-cutout .download-preview-mobile .cutout-header[data-cutout-position=center]>.cutout-title{margin-left:0}
.download-preview-body{display:flex;min-width:0;min-height:0;padding:0;overflow:hidden}
.download-preview-content{position:relative;display:flex;flex:1;flex-direction:column;width:100%;min-width:0;min-height:0;background:#11161c}
.download-preview-status{display:flex;align-items:center;justify-content:center;gap:8px;position:absolute;inset:0;padding:16px;color:#8d9aaa;font-size:12px;text-align:center;z-index:1}

.download-preview-pdf{display:block;flex:1;width:100%;height:100%;border:0;background:#fff;color-scheme:light}

.download-preview-truncated{padding:7px 12px;border-top:1px solid #303947;flex:none;font-size:10px;color:#8190a3}

</style>
