<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { MarkdownDocument } from '@comark/vue'
import type { MarkdownDocument as MarkdownTree } from 'comark'
import { ProseA, ProseBlockquote, ProseCode, ProseEm, ProseH1, ProseH2, ProseH3, ProseH4, ProseHr,
  ProseImg, ProseLi, ProseOl, ProseP, ProsePre, ProseStrong, ProseTable, ProseTbody, ProseTd, ProseTh, ProseThead, ProseTr, ProseUl } from '@nuxt/ui/components/prose'
import UButton from '@nuxt/ui/components/Button.vue'
import { isMarkdownFile, parseFileMarkdown } from '../markdown'

const props = defineProps<{ text: string; filename: string }>()
const { t } = useI18n()
const markdown = computed(() => isMarkdownFile(props.filename))
const rendered = ref(markdown.value), wrap = ref(false)
const document = shallowRef<MarkdownTree>()
const failed = ref(false), loading = ref(false)
const prose = { ProseA, ProseBlockquote, ProseCode, ProseEm, ProseH1, ProseH2, ProseH3, ProseH4, ProseHr,
  ProseImg, ProseLi, ProseOl, ProseP, ProsePre, ProseStrong, ProseTable, ProseTbody, ProseTd, ProseTh, ProseThead, ProseTr, ProseUl }
let revision = 0
watch(() => props.filename, () => { rendered.value = markdown.value })
watch([() => props.text, rendered], async () => {
  const current = ++revision
  document.value = undefined; failed.value = false; loading.value = false
  if (!rendered.value || !markdown.value) return
  loading.value = true
  try { const value = await parseFileMarkdown(props.text); if (current === revision) document.value = value }
  catch { if (current === revision) failed.value = true }
  finally { if (current === revision) loading.value = false }
}, { immediate: true })
</script>

<template>
  <div class="text-preview" :data-text-mode="rendered && markdown ? 'rendered' : 'source'">
    <div class="text-preview-tools" @pointerdown.stop>
      <div v-if="markdown" class="text-preview-modes" role="group" :aria-label="t('panels.preview.mode')">
        <UButton color="neutral" :variant="!rendered ? 'soft' : 'ghost'" size="xs" :aria-pressed="!rendered" @click="rendered = false">{{ t('panels.preview.source') }}</UButton>
        <UButton color="neutral" :variant="rendered ? 'soft' : 'ghost'" size="xs" :aria-pressed="rendered" @click="rendered = true">{{ t('panels.preview.rendered') }}</UButton>
      </div>
      <UButton v-if="!rendered || !markdown" color="neutral" :variant="wrap ? 'soft' : 'ghost'" size="xs" :aria-pressed="wrap" @click="wrap = !wrap">{{ t('panels.preview.wrap') }}</UButton>
    </div>
    <pre v-if="!rendered || !markdown" class="text-preview-source" :class="{ 'text-preview-wrap': wrap }" :aria-label="filename" tabindex="0">{{ text }}</pre>
    <div v-else class="text-preview-markdown" :aria-label="filename" tabindex="0">
      <div v-if="loading" class="text-preview-status" role="status"><span class="spinner" />{{ t('common.loading') }}</div>
      <div v-else-if="failed" class="text-preview-status" role="alert">{{ t('panels.preview.unavailable') }}</div>
      <Suspense v-else-if="document"><MarkdownDocument :value="document" :components="prose" /><template #fallback><span class="spinner" /></template></Suspense>
    </div>
  </div>
</template>

<style scoped>
.text-preview{display:flex;flex:1;flex-direction:column;min-height:0;min-width:0;width:100%;overflow:hidden;background:#14191f;color:#cdd5e1}
.text-preview-tools{display:flex;align-items:center;justify-content:space-between;flex:none;gap:8px;min-height:31px;padding:3px 6px;border-bottom:1px solid #303947;background:#1a2028;font-size:10px}.text-preview-modes{display:flex;gap:2px}.text-preview-tools button{font-size:10px;min-height:24px}
.text-preview-source,.text-preview-markdown{flex:1;min-width:0;min-height:0;overflow:auto;margin:0;padding:12px;user-select:text;-webkit-user-select:text;touch-action:pan-x pan-y;scrollbar-width:thin;outline:none}
.text-preview-source{font-family:var(--content-font-family,monospace);font-feature-settings:var(--content-font-features);font-size:13px;line-height:1.5;white-space:pre;tab-size:4}
.text-preview-wrap{white-space:pre-wrap;overflow-wrap:anywhere}
.text-preview-markdown{font-family:var(--content-font-family,monospace);font-feature-settings:var(--content-font-features);font-size:13px;line-height:1.65;overflow-wrap:anywhere}
.text-preview-markdown :deep(>div>*:first-child){margin-top:0}.text-preview-markdown :deep(>div>*:last-child){margin-bottom:0}.text-preview-markdown :deep(p){font-size:inherit;line-height:inherit;margin-block:10px}.text-preview-markdown :deep(pre){font-size:12px;max-width:100%;overflow:auto}.text-preview-markdown :deep(img){max-width:100%;height:auto}.text-preview-markdown :deep(a){overflow-wrap:anywhere}.text-preview-markdown :deep(table){font-size:12px}
.text-preview-status{display:flex;align-items:center;justify-content:center;gap:8px;min-height:80px;color:#8392a5;font-size:11px}
</style>
