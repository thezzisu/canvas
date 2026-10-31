<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, inject, onBeforeUnmount, ref, watch } from 'vue'
import UModal from '@nuxt/ui/components/Modal.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UDropdownMenu, { type DropdownMenuItem } from '@nuxt/ui/components/DropdownMenu.vue'
import { DialogTitle } from 'reka-ui'
import Icon from './Icon.vue'
import ImagePreview from './ImagePreview.vue'
import TextPreview from './TextPreview.vue'
import TextPreviewActions from './TextPreviewActions.vue'
import { downloadPreview, downloadPreviewCount, dismissDownloadPreview } from '../downloads'
import { readTextPreview } from '../text-preview'
import { downloadMedia, useMediaUrl } from '../media'
import { reportDownloadError } from '../downloads'
import { apiFetch } from '../api'
import { useMobileViewport } from '../viewport'
import { cutoutActiveKey, cutoutPosition, cutoutWidth, useCompactHeader } from '../display-cutout'
import { isMarkdownFile } from '../markdown'
import { useMobileLayout } from '../mobile-layout'
import { usePointerDismiss } from '../pointer-dismiss'

const { t, n } = useI18n()

defineProps<{ portal?: HTMLElement }>()
const pdfPreview = navigator.pdfViewerEnabled
const { url: previewUrl, error: ticketError, retry: retryTicket } = useMediaUrl(() => downloadPreview.value?.preview === 'text' ? undefined : downloadPreview.value?.url)
const text = ref('')
const loading = ref(false)
const error = ref<string | Error>('')
const truncated = ref(false)
const expanded = ref(false)
const rendered = ref(true), wrap = ref(false)
const menuOpen = ref(false), menuTrigger = ref<InstanceType<typeof UButton>>()
const menuDismiss = usePointerDismiss(menuOpen, menuTrigger)
const header = ref<HTMLElement>()
const cutoutActive = inject(cutoutActiveKey, ref(false))
const mobile = useMobileLayout()
const markdown = computed(() => downloadPreview.value?.preview === 'text' && isMarkdownFile(downloadPreview.value.filename))
const imageSize = ref<{ width: number; height: number }>()
const { viewport } = useMobileViewport(ref(true))
const mobileHeader = computed(() => mobile.value || viewport.value.width <= 600)
const compact = useCompactHeader(header, () => cutoutActive.value && mobileHeader.value && expanded.value)
function download() { const preview = downloadPreview.value; if (preview) void downloadMedia(preview.url, preview.filename).catch(reportDownloadError) }
const menu = computed<DropdownMenuItem[]>(() => [
  ...(markdown.value && compact.value ? [{ label: t('panels.preview.source'), type: 'checkbox' as const, checked: !rendered.value, onUpdateChecked: (checked: boolean) => { rendered.value = !checked } }] : []),
  ...(downloadPreview.value?.preview === 'text' && (!markdown.value || !rendered.value) ? [{ label: t('panels.preview.wrap'), type: 'checkbox' as const, checked: wrap.value, onUpdateChecked: (checked: boolean) => { wrap.value = checked } }] : []),
  { label: t('panels.file.download'), onSelect: download },
  { label: t(expanded.value ? 'panels.preview.exitFullscreen' : 'panels.preview.fullscreen'), onSelect: () => { expanded.value = !expanded.value } },
  ...(expanded.value ? [{ label: t('panels.preview.close'), onSelect: dismissDownloadPreview }] : []),
])
const modalStyle = computed(() => {
  const visible = viewport.value, narrow = visible.width <= 600
  let width = Math.min(1000, visible.width - (narrow ? 12 : 32))
  let height = Math.min(800, visible.height - (narrow ? 24 : 48))
  if (downloadPreview.value?.preview === 'image' && imageSize.value) {
    const image = imageSize.value
    // The image viewport excludes the 44px header, 40px tools and two borders.
    const scale = Math.min(1, Math.max(1, width - 2) / image.width, Math.max(1, height - 86) / image.height)
    width = Math.min(width, Math.max(300, image.width * scale + 2))
    height = Math.min(height, Math.max(126, image.height * scale + 86))
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
    if (request === current && !current.signal.aborted) error.value = reason instanceof Error ? reason : 'panels.preview.unavailable'
  } finally { if (request === current) loading.value = false }
}
watch(downloadPreview, preview => {
  request?.abort(); request = undefined
  text.value = ''; error.value = ''; truncated.value = false
  expanded.value = false; imageSize.value = undefined
  rendered.value = true; wrap.value = false
  loading.value = preview?.preview === 'image'
  if (preview?.preview === 'text') void loadText()
}, { immediate: true })
function imageLoaded(id: string, width: number, height: number) {
  if (id !== downloadPreview.value?.id) return
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
const modalContent = computed(() => ({ style: modalStyle.value, onCloseAutoFocus: preventReturnFocus, onEscapeKeyDown: stopEscape }))
onBeforeUnmount(() => request?.abort())
</script>

<template>
  <UModal v-if="downloadPreview" :key="downloadPreview.id" :open="true" :title="downloadPreview.filename" :portal="portal || false" :fullscreen="expanded" :transition="false"
    :close="false" :content="modalContent"
    :ui="{ content: `download-preview-modal${expanded ? ' download-preview-fullscreen' : ''}${mobileHeader ? ' download-preview-mobile' : ''}`, overlay: 'download-preview-overlay', header: 'download-preview-header-slot', body: 'download-preview-body' }"
    @update:open="openChanged">
    <template #header>
      <header ref="header" class="download-preview-header" :class="{ 'cutout-header': mobileHeader && expanded }" :data-cutout-position="mobileHeader && expanded && cutoutWidth > 0 ? cutoutPosition : undefined" :style="{ '--cutout-width': `${cutoutWidth}px` }">
        <DialogTitle class="download-preview-title" :class="{ 'cutout-title': mobileHeader && expanded }">{{ downloadPreview.filename }}<span v-if="downloadPreviewCount > 1" class="download-preview-count" :aria-label="t('panels.preview.remaining', downloadPreviewCount - 1)"> +{{ n(downloadPreviewCount - 1) }}</span></DialogTitle>
        <div class="download-preview-actions" :class="{ 'cutout-actions': mobileHeader && expanded }">
          <TextPreviewActions v-if="downloadPreview.preview === 'text' && !loading && !error && (!mobileHeader || markdown && !compact)" :filename="downloadPreview.filename" v-model:rendered="rendered" v-model:wrap="wrap" :hide-wrap="mobileHeader" />
          <UButton v-if="!mobileHeader || !markdown && !compact" type="button" color="neutral" variant="ghost" class="download-preview-button download-preview-download" :aria-label="t('panels.file.download')" :title="t('panels.file.download')" @click="download"><Icon name="download" :size="16" /></UButton>
          <UDropdownMenu v-if="mobileHeader" v-model:open="menuOpen" :modal="false" :items="menu" :portal="portal || false" :content="{ align: 'end', ...menuDismiss }" :ui="{ content: 'card-action-menu download-preview-menu' }">
            <UButton ref="menuTrigger" type="button" color="neutral" variant="ghost" class="download-preview-button" :aria-label="t('common.more')" :title="t('common.more')"><Icon name="more" :size="17" /></UButton>
          </UDropdownMenu>
          <UButton v-else type="button" color="neutral" variant="ghost" class="download-preview-button download-preview-expand" :aria-label="t(expanded ? 'panels.preview.exitFullscreen' : 'panels.preview.fullscreen')" :title="t(expanded ? 'panels.preview.exitFullscreen' : 'panels.preview.fullscreen')" :aria-pressed="expanded" @click="expanded = !expanded"><Icon :name="expanded ? 'collapse' : 'expand'" :size="16" /></UButton>
          <UButton type="button" color="neutral" variant="ghost" class="download-preview-button download-preview-close" :aria-label="t(mobileHeader && expanded ? 'panels.preview.exitFullscreen' : 'panels.preview.close')" :title="t(mobileHeader && expanded ? 'panels.preview.exitFullscreen' : 'panels.preview.close')" @click="mobileHeader && expanded ? expanded = false : dismissDownloadPreview()"><Icon :name="mobileHeader && expanded ? 'collapse' : 'close'" :size="17" /></UButton>
        </div>
      </header>
    </template>
    <template #body>
      <div class="download-preview-content" :data-download-id="downloadPreview.id" :data-preview-kind="downloadPreview.preview">
        <div v-if="ticketError && !previewUrl" class="download-preview-status" role="alert"><span>{{ t('panels.preview.unavailable') }}</span><button type="button" @click="retryTicket">{{ t('common.retry') }}</button></div>
        <div v-else-if="loading || (downloadPreview.preview !== 'text' && !previewUrl)" class="download-preview-status" role="status"><span class="spinner" /> {{ t('common.loading') }}</div>
        <div v-if="error" class="download-preview-status" role="alert"><span>{{ error instanceof Error ? error.message : t(error) }}</span><button v-if="downloadPreview.preview === 'text'" type="button" @click="loadText">{{ t('common.retry') }}</button></div>
        <ImagePreview v-if="downloadPreview.preview === 'image' && previewUrl && !error" :key="downloadPreview.id" :id="downloadPreview.id" :src="previewUrl" :alt="downloadPreview.filename" @loaded="imageLoaded" @failed="imageFailed" />
        <template v-else-if="downloadPreview.preview === 'pdf'">
          <iframe v-if="pdfPreview && previewUrl" class="download-preview-pdf" :src="previewUrl" :title="downloadPreview.filename" referrerpolicy="no-referrer" />
          <div v-else class="download-preview-status">{{ t('panels.preview.pdfUnavailable') }}</div>
        </template>
        <template v-else-if="downloadPreview.preview === 'text' && !loading && !error">
          <TextPreview :text="text" :filename="downloadPreview.filename" :rendered="rendered" :wrap="wrap" />
          <div v-if="truncated" class="download-preview-truncated">{{ t('panels.preview.truncated') }}</div>
        </template>
      </div>
    </template>
  </UModal>
</template>

<style>
.download-preview-overlay{z-index:84}
.download-preview-modal{--preview-safe-top:var(--mobile-safe-top,env(safe-area-inset-top,0px));--preview-safe-bottom:var(--mobile-safe-bottom,env(safe-area-inset-bottom,0px));--preview-frame-width:var(--mobile-width,var(--preview-viewport-width));--preview-frame-height:var(--mobile-height,var(--preview-viewport-height));z-index:85;display:grid;grid-template-rows:auto minmax(0,1fr);gap:0;position:fixed;left:calc(var(--mobile-left,var(--preview-left)) + (var(--preview-frame-width) + env(safe-area-inset-left,0px) - env(safe-area-inset-right,0px))/2);top:calc(var(--mobile-top,var(--preview-top)) + (var(--preview-frame-height) + var(--preview-safe-top) - var(--preview-safe-bottom))/2);translate:-50% -50%;width:min(var(--preview-width),calc(var(--preview-frame-width) - 12px - env(safe-area-inset-left,0px) - env(safe-area-inset-right,0px)));max-width:none;height:min(var(--preview-height),calc(var(--preview-frame-height) - 24px - var(--preview-safe-top) - var(--preview-safe-bottom)));max-height:none;overflow:auto;overscroll-behavior:contain;background:#191d23;border:1px solid #3b424c;box-shadow:0 16px 60px #0005}
.download-preview-modal.download-preview-fullscreen{box-sizing:border-box;left:var(--mobile-left,var(--preview-left));top:var(--mobile-top,var(--preview-top));right:auto;bottom:auto;translate:none;width:var(--preview-frame-width);height:var(--preview-frame-height);max-width:none;max-height:none;border:0;border-radius:0;padding:var(--preview-safe-top) env(safe-area-inset-right,0px) var(--preview-safe-bottom) env(safe-area-inset-left,0px)}
.download-preview-header-slot{display:contents}
.download-preview-header{--header-action-size:28px;display:flex;align-items:center;height:44px;min-height:44px;padding:0 8px 0 12px;gap:0;border-bottom:1px solid #343a43}
.download-preview-title{display:block;flex:1;min-width:0;font-size:13px;font-weight:500;letter-spacing:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#d6dce5}
.download-preview-count{font-size:10px;color:#8290a1;font-variant-numeric:tabular-nums}
.download-preview-actions{display:flex;flex:none;gap:0;align-items:center}
.download-preview-button{position:static;flex:none;display:flex;align-items:center;justify-content:center;width:var(--header-action-size);min-width:var(--header-action-size);height:var(--header-action-size);padding:0;color:#93a1b4;border-radius:5px}
.download-preview-button:hover{background:#ffffff08;color:#d4dfec}
.card-action-menu.download-preview-menu{z-index:90}
.download-preview-mobile .download-preview-header{--header-action-size:44px;padding:0}
.download-preview-mobile .download-preview-title{padding-left:12px}
.download-preview-modal{container-type:inline-size}
.canvas-fullscreen.has-display-cutout .download-preview-fullscreen.download-preview-mobile{padding-top:0}
.canvas-fullscreen.has-display-cutout .download-preview-mobile .cutout-header[data-cutout-position=center]>.cutout-title{margin-left:0}
.download-preview-body{display:flex;min-width:0;min-height:0;padding:0;overflow:hidden}
.download-preview-content{position:relative;display:flex;flex:1;flex-direction:column;width:100%;min-width:0;min-height:0;background:#11161c}
.download-preview-status{display:flex;align-items:center;justify-content:center;gap:8px;position:absolute;inset:0;padding:16px;color:#8d9aaa;font-size:12px;text-align:center;z-index:1}
.download-preview-status button{color:#d4ac8e}
.download-preview-pdf{display:block;flex:1;width:100%;height:100%;border:0;background:#fff;color-scheme:light}
.download-preview-text:focus-visible{box-shadow:inset 0 0 0 1px #b18a6d}
.download-preview-truncated{padding:7px 12px;border-top:1px solid #303947;flex:none;font-size:10px;color:#8190a3}

</style>
