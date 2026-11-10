<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import UButton from '@nuxt/ui/components/Button.vue'
import UInputMenu from '@nuxt/ui/components/InputMenu.vue'
import USwitch from '@nuxt/ui/components/Switch.vue'
import type { useContentFontEditor } from '../content-font-editor'
import Icon from './Icon.vue'

// A view of the settings dialog's font draft; it owns no lifecycle of its own.
defineProps<{ editor: ReturnType<typeof useContentFontEditor> }>()
const { t, n } = useI18n()
</script>

<template>
  <form class="font-settings" @submit.prevent>
    <div class="font-stack-heading"><span>{{ t('settings.contentFont') }}</span><UButton type="button" color="neutral" variant="ghost" size="xs" class="font-add" :disabled="editor.draft.stack.length >= 12" :aria-label="t('settings.addFont')" @click="editor.addFont"><Icon name="plus" :size="13" /> {{ t('settings.add') }}</UButton></div>
    <ol class="font-stack" :aria-label="t('settings.fontOrder')">
      <li v-for="(entry, index) in editor.draft.stack" :key="editor.entryIds[index]" class="font-stack-entry">
        <div class="font-stack-row">
          <span class="font-order" :title="t(index === 0 ? 'settings.primaryFont' : 'settings.fallbackFont')">{{ n(index + 1) }}</span>
          <UInputMenu :model-value="entry.family" mode="autocomplete" :items="editor.families" :open-on-focus="false" size="sm" class="font-family-input" :aria-label="t('settings.font', { index: n(index + 1) })" :title="entry.family" :placeholder="t('settings.fontPlaceholder')" :maxlength="100"
            :ui="{ content: 'font-select-menu', item: 'font-select-item', viewport: 'font-select-viewport', trailing: 'font-family-trailing' }" @update:model-value="editor.setFamily(index, $event)"><template #empty><span class="font-local-hint">{{ t('settings.localFont') }}</span></template></UInputMenu>
          <UButton type="button" color="neutral" variant="ghost" size="xs" class="font-order-button" :disabled="index === 0" :aria-label="t('settings.moveFontUp', { index: n(index + 1) })" @click="editor.moveFont(index, -1)"><Icon name="down" :size="13" class="font-up" /></UButton>
          <UButton type="button" color="neutral" variant="ghost" size="xs" class="font-order-button" :disabled="index === editor.draft.stack.length - 1" :aria-label="t('settings.moveFontDown', { index: n(index + 1) })" @click="editor.moveFont(index, 1)"><Icon name="down" :size="13" /></UButton>
          <UButton type="button" color="neutral" variant="ghost" size="xs" class="font-order-button" :disabled="editor.draft.stack.length === 1" :aria-label="t('settings.deleteFont', { index: n(index + 1) })" @click="editor.removeFont(index)"><Icon name="close" :size="13" /></UButton>
        </div>
      </li>
    </ol>
    <div class="font-options"><USwitch v-model="editor.draft.ligatures" :label="t('settings.ligatures')" :aria-label="t('settings.ligatures')" size="sm" /><span class="font-stack-hint">{{ t('settings.fallbackOrder') }}</span></div>
    <div class="font-preview-wrap">
      <div class="font-preview-heading"><span>{{ t('settings.preview') }}</span><span v-if="editor.loading || editor.saving" class="font-loading" role="status"><span class="spinner" />{{ t(editor.saving ? 'settings.applying' : 'settings.loadingFont') }}</span></div>
      <pre class="font-preview" :style="editor.previewStyle" :aria-busy="editor.loading" :aria-label="t('settings.fontPreview')">{{ editor.previewText }}</pre>
    </div>
    <div v-if="editor.fontError" class="font-error" role="alert"><span>{{ editor.fontErrorMessage }}</span><UButton type="button" color="neutral" variant="link" size="xs" :aria-label="t('settings.retryFont')" @click="editor.retryPreview">{{ t('common.retry') }}</UButton></div>
  </form>
</template>
