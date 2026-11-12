<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import UApp from '@nuxt/ui/components/App.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import FileIcon from './FileIcon.vue'
import UDropdownMenu from '@nuxt/ui/components/DropdownMenu.vue'
import TextPreview from './TextPreview.vue'
import TextPreviewActions from './TextPreviewActions.vue'
import TrustedPreviewDialog from './TrustedPreviewDialog.vue'
import { readTextPreview } from '../../utils/files/text-preview'
import { requestTrustedPreview } from '../../composables/files/trusted-preview'
import { uiLocale } from '../../plugins/i18n'
import { documentLocation } from '../../utils/files/document-location'
import { useMobileLayout } from '../../composables/mobile-layout'
import { useDocumentInputMode } from '../../composables/files/document-input'
import { useTextPreviewActions } from '../../composables/files/text-preview-actions'
const { t } = useI18n()
const document = documentLocation(location.href),
  filename = document?.filename || ''
const resources = document?.resources
const mobile = useDocumentInputMode(useMobileLayout()),
  narrow = useMediaQuery('(max-width: 600px)')
const compact = computed(() => mobile.value || narrow.value)
const rendered = ref(true),
  wrap = ref(false),
  formatted = ref(false),
  highlighted = ref(true)
const text = ref(''),
  loading = ref(true),
  error = ref(false),
  truncated = ref(false)
const controller = new AbortController()
const menu = useTextPreviewActions(
  filename,
  { rendered, wrap, formatted, highlighted },
  {
    sourcePreview: () => /\.html?$/i.test(filename),
    hideSite: () => !/\.html?$/i.test(filename),
    preview: openOriginal,
  },
)
async function load() {
  try {
    if (!document) throw new Error('Invalid source path')
    const result = await readTextPreview(document.raw.href, Infinity, controller.signal)
    text.value = result.text
    truncated.value = result.truncated
  } catch {
    if (!controller.signal.aborted) error.value = true
  } finally {
    loading.value = false
  }
}
function openOriginal() {
  requestTrustedPreview(filename, () => {
    if (!document) return
    window.open(document.source.href, '_blank', 'noopener,noreferrer')
  })
}
window.document.title = filename + ' - Canvas'
void load()
onBeforeUnmount(() => controller.abort())
</script>
<template>
  <UApp :locale="uiLocale">
    <main class="document-preview" :class="{ 'document-touch': mobile }">
      <header>
        <span class="document-name" :title="filename"
          ><FileIcon class="me-2" :name="filename" :size="16" />{{ filename }}</span
        >
        <TextPreviewActions
          v-if="!compact"
          v-model:rendered="rendered"
          v-model:wrap="wrap"
          v-model:formatted="formatted"
          v-model:highlighted="highlighted"
          :filename="filename"
          :source-preview="/\.html?$/i.test(filename)"
          :hide-site="!/\.html?$/i.test(filename)"
          @preview="openOriginal"
        />
        <UDropdownMenu
          v-else
          :items="menu"
          :modal="false"
          :ui="mobile ? { item: 'min-h-[44px] items-center' } : undefined"
          ><UButton
            class="document-action"
            icon="i-lucide-ellipsis"
            color="neutral"
            variant="ghost"
            :aria-label="t('common.more')"
        /></UDropdownMenu>
        <UButton
          class="document-action"
          :href="document?.raw.href"
          :disabled="!document"
          icon="i-lucide-file-code"
          color="neutral"
          variant="ghost"
          :title="t('panels.preview.raw')"
          :aria-label="t('panels.preview.raw')"
        /><UButton
          class="document-action"
          :href="document?.download.href"
          :disabled="!document"
          icon="i-lucide-download"
          color="neutral"
          variant="ghost"
          :title="t('panels.file.download')"
          :aria-label="t('panels.file.download')"
        />
      </header>
      <p v-if="loading || error" role="status">
        {{ t(error ? 'panels.preview.unavailable' : 'common.loading') }}
      </p>
      <TextPreview
        v-else
        v-model:formatted="formatted"
        v-model:highlighted="highlighted"
        :text="text"
        :filename="filename"
        :resources="resources"
        :rendered="rendered"
        :wrap="wrap"
      />
      <p v-if="truncated" role="status">{{ t('panels.preview.truncated') }}</p>
    </main>
    <TrustedPreviewDialog />
  </UApp>
</template>
<style>
html.document-mode {
  font-family:
    'DM Sans',
    'Noto Sans SC',
    -apple-system,
    BlinkMacSystemFont,
    'Segoe UI',
    sans-serif;
  font-size: 13px;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
}
html,
body,
#app {
  margin: 0;
  min-height: 100%;
  height: 100%;
}
.document-preview {
  height: 100dvh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #14191f;
  color: #cdd5e1;
}
.document-preview > header {
  flex: none;
  min-height: 44px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-bottom: 1px solid #343740;
}
.document-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
.document-preview > p {
  padding: 12px;
  font-size: 13px;
}
.document-touch .document-action {
  width: 44px;
  height: 44px;
  justify-content: center;
  flex: none;
}
</style>
