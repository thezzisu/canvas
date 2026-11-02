<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import UModal from './CanvasModal.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UTabs from '@nuxt/ui/components/Tabs.vue'
import UFormField from '@nuxt/ui/components/FormField.vue'
import { buildRichPaste, type RichPasteOptions } from '../rich-paste'
import { richPasteRequest } from '../rich-paste-dialog'
import { MAX_PASTE_PARTS, MAX_UPLOAD_BEGIN_BYTES } from '../../../shared/paste'

defineProps<{ portal?: HTMLElement }>()
const { t } = useI18n()
const text = ref<RichPasteOptions['text']>('markdown')
const attachments = ref<RichPasteOptions['attachments']>('markdown')
watch(richPasteRequest, () => { text.value = 'markdown'; attachments.value = 'markdown' }, { flush: 'sync' })
watch(text, value => { if (value === 'plain' && attachments.value === 'markdown') attachments.value = 'path' }, { flush: 'sync' })
const bodyItems = computed(() => [
  { label: t('terminal.richPaste.markdown'), value: 'markdown' },
  { label: t('terminal.richPaste.plain'), value: 'plain' },
])
const attachmentItems = computed(() => [
  { label: t('terminal.richPaste.links'), value: 'markdown', disabled: text.value !== 'markdown' },
  { label: t('terminal.richPaste.paths'), value: 'path' },
  { label: t('terminal.richPaste.skip'), value: 'skip' },
])
const result = computed(() => richPasteRequest.value && buildRichPaste(richPasteRequest.value.model, { text: text.value, attachments: attachments.value }))
const error = computed(() => {
  const value = result.value
  if (!value) return ''
  if (value.missing) return t('terminal.richPaste.missing')
  const message = { type: 'upload-begin', id: '00000000-0000-0000-0000-000000000000', files: value.files.map(file => ({ name: file.name, size: file.size })), parts: value.parts }
  return value.parts.length > MAX_PASTE_PARTS || value.files.length > 64 || new TextEncoder().encode(JSON.stringify(message)).length > MAX_UPLOAD_BEGIN_BYTES ? t('terminal.richPaste.tooLarge') : ''
})
function close(open = false) { if (!open) richPasteRequest.value?.dismiss() }
function confirm() {
  const request = richPasteRequest.value, value = result.value
  if (!request || !value?.preview || error.value) return
  request.dismiss()
  request.submit(value)
}
const content = { onCloseAutoFocus: (event: Event) => event.preventDefault(), onEscapeKeyDown: (event: Event) => event.stopPropagation() }
</script>

<template>
  <UModal v-if="richPasteRequest" :open="true" :transition="false" :title="t('terminal.richPaste.title')" :description="undefined" :portal="portal || false" :content="content"
    :close="{ 'aria-label': t('common.close') }" :ui="{ content: 'rich-paste-modal', overlay: 'z-[74]', body: 'rich-paste-body', footer: 'justify-end gap-2' }" @update:open="close">
    <template #body>
      <div class="rich-paste-options">
        <UFormField :label="t('terminal.richPaste.body')"><UTabs v-model="text" :items="bodyItems" :content="false" size="sm" :aria-label="t('terminal.richPaste.body')" /></UFormField>
        <UFormField :label="t('terminal.richPaste.attachments')"><UTabs v-model="attachments" :items="attachmentItems" :content="false" size="sm" :aria-label="t('terminal.richPaste.attachments')" /></UFormField>
      </div>
      <pre data-paste-preview class="rich-paste-preview" tabindex="0">{{ result?.preview }}</pre>
      <p v-if="error" class="rich-paste-error" role="alert">{{ error }}</p>
    </template>
    <template #footer>
      <UButton color="neutral" variant="ghost" @click="close()">{{ t('common.cancel') }}</UButton>
      <UButton :disabled="!!error || !result?.preview" @click="confirm">{{ t('terminal.richPaste.paste') }}</UButton>
    </template>
  </UModal>
</template>

<style>
.rich-paste-modal{--paste-safe-top:var(--mobile-safe-top,var(--ui-safe-top));--paste-safe-bottom:var(--mobile-safe-bottom,var(--ui-safe-bottom));position:fixed;z-index:75;left:calc(var(--mobile-left,0px) + (var(--mobile-width,var(--ui-viewport-width)) + var(--ui-safe-left) - var(--ui-safe-right))/2);top:calc(var(--mobile-top,0px) + (var(--mobile-height,var(--ui-viewport-height)) + var(--paste-safe-top) - var(--paste-safe-bottom))/2);translate:-50% -50%;width:min(640px,calc(var(--mobile-width,var(--ui-viewport-width)) - 24px - var(--ui-safe-left) - var(--ui-safe-right)));max-width:none;max-height:calc(var(--mobile-height,var(--ui-viewport-height)) - 24px - var(--paste-safe-top) - var(--paste-safe-bottom));overflow:hidden}
.rich-paste-body{min-height:0;overflow:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:16px}
.rich-paste-options{display:flex;flex-wrap:wrap;gap:12px 20px}.rich-paste-options>div{min-width:0;flex:1 1 auto}
.rich-paste-preview{margin:0;min-height:120px;max-height:45dvh;flex-shrink:0;overflow:auto;overscroll-behavior:contain;white-space:pre-wrap;overflow-wrap:anywhere;tab-size:4;border:1px solid var(--border);border-radius:8px;padding:14px;background:#15171b;font-family:var(--content-font-family);font-feature-settings:var(--content-font-features);font-size:13px;line-height:1.7;color:#d5d7dd;user-select:text}
.rich-paste-error{margin:0;color:var(--danger);font-size:12px;line-height:1.5}
</style>
