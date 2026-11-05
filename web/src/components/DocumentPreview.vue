<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import UApp from '@nuxt/ui/components/App.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import TextPreview from './TextPreview.vue'
import TextPreviewActions from './TextPreviewActions.vue'
import TrustedPreviewDialog from './TrustedPreviewDialog.vue'
import { readTextPreview } from '../text-preview'
import { requestTrustedPreview } from '../trusted-preview'
import { uiLocale } from '../i18n'
import { documentLocation } from '../document-location'
const { t } = useI18n()
const document = documentLocation(location.href), filename = document?.filename || ''
const resources = document?.resources
const rendered = ref(true), wrap = ref(false), formatted = ref(false), highlighted = ref(true)
const text = ref(''), loading = ref(true), error = ref(false), truncated = ref(false)
const controller = new AbortController()
async function load() {
  try {
    if (!document) throw new Error('Invalid source path')
    const result = await readTextPreview(document.raw.href, Infinity, controller.signal)
    text.value = result.text; truncated.value = result.truncated
  } catch { if (!controller.signal.aborted) error.value = true }
  finally { loading.value = false }
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
    <main class="document-preview">
      <header><span class="document-name" :title="filename">{{ filename }}</span><TextPreviewActions :filename="filename" v-model:rendered="rendered" v-model:wrap="wrap" v-model:formatted="formatted" v-model:highlighted="highlighted" :source-preview="/\.html?$/i.test(filename)" :hide-site="!/\.html?$/i.test(filename)" @preview="openOriginal" /><UButton :href="document?.raw.href" :disabled="!document" icon="i-lucide-file-code" color="neutral" variant="ghost" :title="t('panels.preview.raw')" :aria-label="t('panels.preview.raw')" /><UButton :href="document?.download.href" :disabled="!document" icon="i-lucide-download" color="neutral" variant="ghost" :title="t('panels.file.download')" :aria-label="t('panels.file.download')" /></header>
      <p v-if="loading || error" role="status">{{ t(error ? 'panels.preview.unavailable' : 'common.loading') }}</p>
      <TextPreview v-else :text="text" :filename="filename" :resources="resources" :rendered="rendered" :wrap="wrap" v-model:formatted="formatted" v-model:highlighted="highlighted" />
      <p v-if="truncated" role="status">{{ t('panels.preview.truncated') }}</p>
    </main>
    <TrustedPreviewDialog />
  </UApp>
</template>
<style>
html,body,#app{margin:0;min-height:100%;height:100%}.document-preview{height:100dvh;display:flex;flex-direction:column;overflow:hidden;background:#14191f;color:#cdd5e1}.document-preview>header{flex:none;min-height:44px;display:flex;align-items:center;gap:4px;padding:4px 8px;border-bottom:1px solid #343740}.document-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.document-preview>p{padding:12px;font-size:13px}
</style>
