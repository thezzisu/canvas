<script setup lang="ts">
import UIcon from '@nuxt/ui/components/Icon.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import { useI18n } from 'vue-i18n'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { NodeProps } from '@vue-flow/core'
import { NodeResizer } from '@vue-flow/node-resizer'
import type { DropdownMenuItem } from '@nuxt/ui/components/DropdownMenu.vue'
import type { FileData } from '../api/types'
import FileIcon from './FileIcon.vue'
import CardLayoutControls from '../canvas/CardLayoutControls.vue'
import { useLayoutCard } from '../canvas/layout-editing'
import CardPreview from '../canvas/CardPreview.vue'
import { BinaryFileError, readTextPreview } from './text-preview'
import { filePreview } from './file-preview'
import TextPreview from './TextPreview.vue'
import TextPreviewActions from './TextPreviewActions.vue'
import { useTextPreviewActions } from './text-preview-actions'
import { useSourcePreview } from './source-preview'
import MediaPreview from './MediaPreview.vue'
import ImagePreview from './ImagePreview.vue'
import ContentZoom from '../canvas/ContentZoom.vue'
import CardHeaderActions from '../canvas/CardHeaderActions.vue'
import { contentZoomMenu } from '../canvas/content-zoom-menu'
import { useContentZoom } from '../canvas/content-zoom'
import { isMarkdownFile } from '../notes/markdown'
import { activeInstance } from '../instances/instances'
import { downloadMedia, useMediaUrl } from './media'
import { reportDownloadError } from './downloads'
import { apiFetch } from '../api/api'
import { copyCanvasFile, fileReference } from './file-transfer'
import { writeFileReference } from './file-reference'
import { cutoutPosition, cutoutWidth } from '../lib/display-cutout'
import { useFileView } from './file-view'
import { useCardContentFocus } from '../canvas/card-content-focus'
import { useRetainedFrame } from './retained-frame'

const { t, n } = useI18n()

const props = withDefaults(
  defineProps<Pick<NodeProps<FileData>, 'id' | 'data'> & { selected?: boolean }>(),
  { selected: false },
)
const layoutRoot = ref<HTMLElement>()
const { editing } = useLayoutCard(layoutRoot)
const binary = ref(false)
const preview = computed(() => (binary.value ? 'file' : filePreview(props.data.asset)))
watch(
  () => props.data.assetId,
  () => {
    binary.value = false
  },
)
const mobilePreview = computed(() => !!props.data.mobile && !props.data.focus)
const zoom = useContentZoom(() => props.data.zoomKey)
const markup = computed(
  () =>
    preview.value === 'text' &&
    (isMarkdownFile(props.data.asset.filename) || /\.html?$/iu.test(props.data.asset.filename)),
)
const { rendered, wrap, formatted, highlighted, reading, remember } = useFileView(
  () => props.data.instanceId,
  () => props.data.canvasId,
  () => props.id,
  markup,
  () => props.data.canPersistView(),
)
const sitePreview = useSourcePreview()
const previewBusy = sitePreview.busy
function previewSite() {
  if (props.data.asset.sourcePreview) void sitePreview.open(path.value, props.data.asset.filename)
}
const textActions = useTextPreviewActions(
  () => props.data.asset.filename,
  { rendered, wrap, formatted, highlighted },
  {
    sourcePreview: () => props.data.asset.sourcePreview,
    busy: previewBusy,
    preview: previewSite,
  },
)
const textShortcuts = computed(() =>
  preview.value === 'text' && props.data.focus ? textActions.value.map((item) => item.slot!) : [],
)
const shortcuts = computed(() => [
  ...textShortcuts.value,
  ...(preview.value === 'text' && props.data.focus ? ['zoom'] : []),
  'copy',
])
const menu = computed<DropdownMenuItem[]>(() => [
  ...(preview.value === 'text' ? [...contentZoomMenu(zoom), ...textActions.value] : []),
  { slot: 'copy', label: t('fileTransfer.copy'), icon: 'i-lucide-copy', onSelect: copyFile },
  { label: t('panels.file.download'), icon: 'i-lucide-download', onSelect: download },
  {
    label: t('common.settings'),
    icon: 'i-lucide-settings',
    onSelect: () => props.data.onAction?.('settings', props.id),
  },
])
const sourceInstance = { id: activeInstance.value.id, base: activeInstance.value.base }
const pdfPreview = navigator.pdfViewerEnabled
const path = computed(() => `/api/files/${encodeURIComponent(props.data.assetId)}`)
const {
  url,
  error: ticketError,
  retry: retryTicket,
} = useMediaUrl(() =>
  ['image', 'audio', 'video', 'pdf'].includes(preview.value) ? path.value : undefined,
)
const imageFailed = ref(false)
watch(
  () => props.data.assetId,
  () => {
    imageFailed.value = false
  },
)
function download() {
  void downloadMedia(path.value, props.data.asset.filename).catch(reportDownloadError)
}
const fileBody = ref<HTMLElement>()
const {
  active: contentActive,
  focus: focusContent,
  pointerDown: contentPointerDown,
} = useCardContentFocus(fileBody, () => mobilePreview.value)
// The PDF viewer keeps its page and zoom when the card remounts; renewed tickets do not reload it.
const pdfHost = ref<HTMLElement>()
useRetainedFrame(pdfHost, () =>
  preview.value === 'pdf' && pdfPreview && url.value
    ? {
        key: `pdf:${props.data.instanceId}:${props.data.assetId}`,
        src: url.value,
        attributes: {
          class: 'file-preview nowheel',
          title: props.data.asset.filename,
          referrerpolicy: 'no-referrer',
          tabindex: !props.data.mobile && !contentActive.value ? '-1' : '0',
        },
      }
    : undefined,
)
const text = ref('')
const textLoading = ref(false)
const textError = ref<string | Error>('')
const truncated = ref(false)
function copyFile() {
  copyCanvasFile(props.data.asset, sourceInstance)
}
function dragFile(event: DragEvent) {
  if (!writeFileReference(event.dataTransfer, fileReference(props.data.assetId, sourceInstance)))
    event.preventDefault()
  event.stopPropagation()
}
let visibility: IntersectionObserver | undefined
let request: AbortController | undefined
async function loadText() {
  if (preview.value !== 'text') return
  request?.abort()
  const current = (request = new AbortController())
  textLoading.value = true
  textError.value = ''
  truncated.value = false
  try {
    const result = await readTextPreview(
      path.value,
      props.data.asset.size,
      current.signal,
      apiFetch,
    )
    if (request !== current || current.signal.aborted) return
    text.value = result.text
    truncated.value = result.truncated
  } catch (reason) {
    if (request === current && !current.signal.aborted) {
      if (reason instanceof BinaryFileError) binary.value = true
      else textError.value = reason instanceof Error ? reason : 'panels.file.unreadable'
    }
  } finally {
    if (request === current) textLoading.value = false
  }
}
watch(
  [fileBody, () => props.data.assetId, () => preview.value],
  ([element, _id, preview]) => {
    request?.abort()
    request = undefined
    visibility?.disconnect()
    text.value = ''
    textError.value = ''
    truncated.value = false
    textLoading.value = preview === 'text'
    if (!element || preview !== 'text') return
    visibility = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        visibility?.disconnect()
        void loadText()
      },
      { rootMargin: '200px' },
    )
    visibility.observe(element)
  },
  { immediate: true, flush: 'post' },
)
onBeforeUnmount(() => {
  request?.abort()
  visibility?.disconnect()
})
const size = computed(() => {
  const bytes = props.data.asset.size
  if (bytes < 1024) return `${n(bytes)} B`
  const unit = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${n(bytes / 1024 ** unit, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${['B', 'KiB', 'MiB', 'GiB'][unit]}`
})
</script>

<template>
  <NodeResizer
    v-if="!data.mobile && !data.focus"
    :node-id="id"
    :min-width="240"
    :min-height="160"
    :max-width="4000"
    :max-height="3000"
    @resize-start="(event) => data.onResizeStart(id, event.params)"
    @resize-end="
      (event) =>
        data.onResize(id, event.params.width, event.params.height, event.params.x, event.params.y)
    "
  />
  <article
    ref="layoutRoot"
    class="file-card"
    :class="{
      'mobile-card-preview': mobilePreview,
      'card-focused': data.focus,
      'input-focused': contentActive,
    }"
    :data-asset-id="data.assetId"
    :data-preview-kind="preview"
  >
    <header
      class="file-header drag-handle"
      :class="{ 'cutout-header': data.focus && data.mobile }"
      :data-cutout-position="
        data.focus && data.mobile && cutoutWidth > 0 ? cutoutPosition : undefined
      "
      :style="
        data.focus && data.mobile
          ? { '--cutout-width': `calc(${cutoutWidth}px / var(--ui-zoom))` }
          : undefined
      "
      :inert="mobilePreview || undefined"
      :aria-hidden="mobilePreview || undefined"
    >
      <span class="file-icon" :class="{ 'cutout-status': data.focus }"
        ><FileIcon :name="data.asset.filename" :size="13"
      /></span>
      <span
        class="file-title"
        :class="{ 'cutout-title': data.focus }"
        :title="`${data.asset.filename} · ${size}`"
        >{{ data.asset.filename }}</span
      >
      <CardHeaderActions
        class="file-actions"
        :class="{ 'cutout-actions': data.mobile && data.focus }"
        :items="menu"
        :expanded="!!data.focus"
        removable
        :mobile="!!data.mobile && !!data.focus"
        :shortcuts="shortcuts"
        :priority="['copy', 'zoom']"
        :add-label="t('app.addToOtherCanvas')"
        :remove-label="t('panels.file.remove')"
        @add="data.onAction?.('add', id)"
        @toggle="data.onAction?.(data.focus ? 'unfocus' : 'focus', id)"
        @remove="data.onRemove(id)"
      >
        <template v-for="key in textShortcuts" :key="key" #[key]
          ><TextPreviewActions
            :only="key"
            :filename="data.asset.filename"
            v-model:rendered="rendered"
            v-model:wrap="wrap"
            v-model:formatted="formatted"
            v-model:highlighted="highlighted"
            :source-preview="data.asset.sourcePreview"
            :preview-busy="previewBusy"
            @preview="previewSite"
        /></template>
        <template #zoom
          ><ContentZoom v-model="zoom" :mobile="data.mobile" :label="t('common.contentZoom')"
        /></template>
        <template #copy
          ><UButton
            class="file-copy"
            icon="i-lucide-copy"
            draggable="true"
            :title="t('fileTransfer.copy')"
            :aria-label="t('fileTransfer.copy')"
            @pointerdown.stop
            @click="copyFile"
            @dragstart="dragFile"
        /></template>
      </CardHeaderActions>
    </header>
    <div
      ref="fileBody"
      class="file-body card-content nodrag nopan outline-primary/25 -outline-offset-3 focus-visible:outline-3"
      :style="{ '--content-zoom': data.focus ? zoom / 100 : 1 }"
      :data-content-active="contentActive"
      :tabindex="mobilePreview ? -1 : 0"
      :aria-label="data.asset.filename"
      :inert="mobilePreview || undefined"
      :aria-hidden="mobilePreview || undefined"
      @pointerdown.capture="contentPointerDown"
      @pointerdown.stop
      @dblclick.stop
    >
      <div
        v-if="
          (['image', 'audio', 'video'].includes(preview) || (preview === 'pdf' && pdfPreview)) &&
          !url
        "
        class="file-text-status"
        :role="ticketError ? 'alert' : 'status'"
      >
        <template v-if="ticketError"
          ><span>{{ t('panels.preview.unavailable') }}</span
          ><UButton variant="link" size="xs" @click="retryTicket">{{
            t('common.retry')
          }}</UButton></template
        >
        <template v-else
          ><UIcon
            name="i-lucide-loader-circle"
            class="spinner size-3.5 shrink-0 motion-safe:animate-spin"
          />{{ t('common.loading') }}</template
        >
      </div>
      <ImagePreview
        v-else-if="preview === 'image' && url && !imageFailed"
        :key="data.assetId"
        :id="data.assetId"
        :src="url"
        :alt="data.asset.filename"
        :read-only="mobilePreview"
        @failed="imageFailed = true"
      />
      <MediaPreview
        v-else-if="(preview === 'audio' || preview === 'video') && url"
        :key="data.assetId"
        :kind="preview"
        :src="url"
        :title="data.asset.filename"
        :read-only="mobilePreview"
        @download="download"
      />
      <div v-else-if="preview === 'text'" class="file-text-body nowheel" @wheel.stop>
        <div v-if="textLoading" class="file-text-status" role="status">
          <UIcon
            name="i-lucide-loader-circle"
            class="spinner size-3.5 shrink-0 motion-safe:animate-spin"
          />
          {{ t('common.loading') }}
        </div>
        <div v-else-if="textError" class="file-text-status" role="alert">
          <span>{{ textError instanceof Error ? textError.message : t(textError) }}</span
          ><UButton variant="link" size="xs" @click="loadText">{{ t('common.retry') }}</UButton>
        </div>
        <TextPreview
          v-else
          :text="text"
          :filename="data.asset.filename"
          :rendered="rendered"
          :wrap="wrap"
          v-model:formatted="formatted"
          v-model:highlighted="highlighted"
          :reading="reading"
          :read-only="mobilePreview"
          @reading="remember"
        />
        <div v-if="truncated" class="file-text-truncated">
          <span>{{ t('panels.preview.truncated') }}</span
          ><UButton variant="link" size="xs" class="shrink-0 p-0" @click="download">{{
            t('panels.file.downloadOriginal')
          }}</UButton>
        </div>
      </div>
      <template v-else-if="preview === 'pdf' && pdfPreview && url">
        <div ref="pdfHost" class="file-preview-host" />
        <div
          v-if="!data.mobile && !contentActive"
          class="file-preview-activate card-content-activate outline-primary/25 -outline-offset-3 focus-visible:outline-3"
          role="button"
          tabindex="0"
          :aria-label="t('common.openCard', { name: data.asset.filename })"
          @click.stop="focusContent"
          @keydown.enter.stop.prevent="focusContent"
          @keydown.space.stop.prevent="focusContent"
        />
      </template>
      <UButton
        v-else
        color="neutral"
        variant="ghost"
        icon="i-lucide-file"
        :label="data.asset.filename"
        class="file-download min-w-0 flex-1 flex-col justify-center gap-3.5 rounded-none p-6"
        :ui="{ leadingIcon: 'size-10', label: 'max-w-full' }"
        :aria-label="t('panels.file.downloadNamed', { name: data.asset.filename })"
        @click="download"
      />
    </div>
    <CardPreview
      v-if="mobilePreview && !editing"
      :label="t('common.openCard', { name: data.asset.filename })"
      @open="data.onAction?.('focus', id)"
    />
  </article>
  <CardLayoutControls
    :id="id"
    :label="data.asset.filename"
    :kind="'file'"
    :width="data.width"
    :height="data.height"
  />
</template>

<style scoped>
.file-card {
  position: relative;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid #3a3d46;
  border-radius: calc(var(--ui-radius) * 2);
  background: #1b1d23;
  box-shadow: 0 5px 18px #0003;
}
.file-header {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 30px;
  flex: 0 0 30px;
  padding: 0 7px 0 10px;
  color: #a9b0be;
  cursor: grab;
  border-bottom: 1px solid #343740;
}
.file-title {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: #e0e3ea;
}
.file-icon {
  display: flex;
  align-items: center;
  flex: none;
}
.file-copy {
  cursor: grab;
}
.file-copy:active {
  cursor: grabbing;
}
.file-body {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}
.file-preview-host {
  width: 100%;
  height: 100%;
}
.file-preview-host :deep(.file-preview) {
  display: block;
  border: 0;
  width: 100%;
  height: 100%;
  background: #fff;
  color-scheme: light;
}
.file-text-body {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-width: 0;
  min-height: 0;
  background: #14191f;
}
.file-text-status {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px;
  color: var(--ui-text-muted);
  font-size: var(--text-xs);
}
.file-text-truncated {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px;
  flex: 0 0 auto;
  padding: 7px 10px;
  border-top: 1px solid var(--ui-border);
  font-size: var(--text-xs);
  color: var(--ui-text-muted);
}
.card-focused .file-header {
  cursor: default;
}
.mobile-layout .card-focused .file-header {
  height: calc(44px + var(--mobile-safe-top, 0px));
  flex-basis: calc(44px + var(--mobile-safe-top, 0px));
  padding: var(--mobile-safe-top, 0px) 0 0;
  gap: 0;
}
.mobile-layout .card-focused .file-title {
  font-size: 13px;
  margin-inline: 6px;
}
.mobile-layout .card-focused .file-icon {
  width: 44px;
  height: 44px;
  justify-content: center;
}
.mobile-layout.canvas-fullscreen .card-focused .file-header {
  height: 44px;
  flex-basis: 44px;
  padding-top: 0;
}
</style>
