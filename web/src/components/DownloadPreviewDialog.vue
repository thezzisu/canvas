<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import UModal from '@nuxt/ui/components/Modal.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import Icon from './Icon.vue'
import { downloadPreview, downloadPreviewCount, dismissDownloadPreview } from '../downloads'
import { readTextPreview } from '../text-preview'

defineProps<{ portal?: HTMLElement }>()
const pdfPreview = navigator.pdfViewerEnabled
const previewUrl = computed(() => downloadPreview.value ? `${downloadPreview.value.url}?preview=1` : '')
const text = ref('')
const loading = ref(false)
const error = ref('')
const truncated = ref(false)
let request: AbortController | undefined

async function loadText() {
  const preview = downloadPreview.value
  if (!preview || preview.preview !== 'text') return
  request?.abort()
  const current = request = new AbortController()
  loading.value = true; error.value = ''
  try {
    const result = await readTextPreview(previewUrl.value, preview.size, current.signal)
    if (request !== current || current.signal.aborted) return
    text.value = result.text; truncated.value = result.truncated
  } catch (reason) {
    if (request === current && !current.signal.aborted) error.value = reason instanceof Error ? reason.message : '无法预览此文件'
  } finally { if (request === current) loading.value = false }
}
watch(downloadPreview, preview => {
  request?.abort(); request = undefined
  text.value = ''; error.value = ''; truncated.value = false
  loading.value = preview?.preview === 'image'
  if (preview?.preview === 'text') void loadText()
}, { immediate: true })
function imageSettled(event: Event, failed = false) {
  const id = (event.currentTarget as HTMLImageElement | null)?.dataset.previewId
  if (!id || id !== downloadPreview.value?.id) return
  loading.value = false
  if (failed) error.value = '无法预览此文件'
}
function openChanged(open: boolean) { if (!open) dismissDownloadPreview() }
function preventReturnFocus(event: Event) { event.preventDefault() }
function stopEscape(event: Event) { event.stopPropagation() }
onBeforeUnmount(() => request?.abort())
</script>

<template>
  <UModal v-if="downloadPreview" :key="downloadPreview.id" :open="true" :title="downloadPreview.filename" :portal="portal || false"
    :close="{ 'aria-label': '关闭预览' }" :content="{ onCloseAutoFocus: preventReturnFocus, onEscapeKeyDown: stopEscape }"
    :ui="{ content: 'download-preview-modal', overlay: 'download-preview-overlay', header: 'download-preview-header', wrapper: 'download-preview-title-wrap', title: 'download-preview-title', body: 'download-preview-body', close: 'download-preview-close' }"
    @update:open="openChanged">
    <template #actions>
      <span v-if="downloadPreviewCount > 1" class="download-preview-count" :aria-label="`还有 ${downloadPreviewCount - 1} 个文件待预览`">+{{ downloadPreviewCount - 1 }}</span>
      <UButton :href="downloadPreview.url" :download="downloadPreview.filename" color="neutral" variant="ghost" size="sm" class="download-preview-download" aria-label="下载文件" @pointerdown.stop @click.stop><Icon name="download" :size="15" />下载</UButton>
    </template>
    <template #body>
      <div class="download-preview-content" :data-download-id="downloadPreview.id" :data-preview-kind="downloadPreview.preview">
        <div v-if="loading" class="download-preview-status" role="status"><span class="spinner" />加载中…</div>
        <div v-if="error" class="download-preview-status" role="alert"><span>{{ error }}</span><button v-if="downloadPreview.preview === 'text'" type="button" @click="loadText">重试</button></div>
        <img v-if="downloadPreview.preview === 'image' && !error" :key="downloadPreview.id" class="download-preview-image" :data-preview-id="downloadPreview.id" :src="previewUrl" :alt="downloadPreview.filename" draggable="false" @load="imageSettled($event)" @error="imageSettled($event, true)" />
        <template v-else-if="downloadPreview.preview === 'pdf'">
          <iframe v-if="pdfPreview" class="download-preview-pdf" :src="previewUrl" :title="downloadPreview.filename" referrerpolicy="no-referrer" />
          <div v-else class="download-preview-status">浏览器不支持 PDF 预览</div>
        </template>
        <template v-else-if="downloadPreview.preview === 'text' && !loading && !error">
          <pre class="download-preview-text" :aria-label="downloadPreview.filename" tabindex="0">{{ text }}</pre>
          <div v-if="truncated" class="download-preview-truncated">已显示前 1 MiB</div>
        </template>
      </div>
    </template>
  </UModal>
</template>

<style>
.download-preview-overlay{z-index:84}
.download-preview-modal{z-index:85;width:min(1000px,calc(100vw - 32px));max-width:none;height:min(800px,calc(100dvh - 48px));max-height:calc(100dvh - 24px);overflow:hidden;background:#191d23;border:1px solid #3b424c;box-shadow:0 16px 60px #0005}
.download-preview-header{min-height:44px;flex:0 0 44px;padding:0 8px 0 13px;gap:6px;border-bottom:1px solid #343a43}
.download-preview-title-wrap{flex:1;min-width:0}
.download-preview-title{font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#d6dce5}
.download-preview-count{flex:none;font-size:10px;color:#8290a1;font-variant-numeric:tabular-nums}
.download-preview-download{flex:none;gap:5px;font-size:11px;color:#bec9d8;text-decoration:none}
.download-preview-close{position:static;flex:none;color:#93a1b4}
.download-preview-body{flex:1;min-height:0;padding:0;overflow:hidden}
.download-preview-content{position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-height:0;background:#11161c}
.download-preview-status{display:flex;align-items:center;justify-content:center;gap:8px;position:absolute;inset:0;padding:16px;color:#8d9aaa;font-size:12px;text-align:center}
.download-preview-status button{color:#d4ac8e}
.download-preview-image{width:100%;height:100%;min-height:0;object-fit:contain}
.download-preview-pdf{display:block;flex:1;width:100%;height:100%;border:0;background:#fff;color-scheme:light}
.download-preview-text{display:block;flex:1;min-height:0;margin:0;padding:14px;overflow:auto;white-space:pre;tab-size:4;font-family:var(--content-font-family,monospace);font-feature-settings:var(--content-font-features);font-size:13px;line-height:1.5;color:#ccd5e1;user-select:text;-webkit-user-select:text;touch-action:pan-x pan-y;scrollbar-width:thin;outline:none}
.download-preview-text:focus-visible{box-shadow:inset 0 0 0 1px #b18a6d}
.download-preview-truncated{padding:7px 12px;border-top:1px solid #303947;flex:none;font-size:10px;color:#8190a3}
@media(max-width:600px){.download-preview-modal{width:calc(100vw - 12px);height:calc(100dvh - 24px);max-height:calc(100dvh - 12px)}.download-preview-header{padding-left:10px}.download-preview-download{min-height:36px}.download-preview-close{min-width:36px;min-height:36px}}
.mobile-layout .download-preview-modal{left:calc(var(--mobile-left,0px) + var(--mobile-width,100vw)/2);top:calc(var(--mobile-top,0px) + var(--mobile-height,100dvh)/2);width:calc(var(--mobile-width,100vw) - 12px - env(safe-area-inset-left,0px) - env(safe-area-inset-right,0px));height:calc(var(--mobile-height,100dvh) - 24px - env(safe-area-inset-top,0px) - env(safe-area-inset-bottom,0px));max-height:calc(var(--mobile-height,100dvh) - 24px - env(safe-area-inset-top,0px) - env(safe-area-inset-bottom,0px))}
</style>
