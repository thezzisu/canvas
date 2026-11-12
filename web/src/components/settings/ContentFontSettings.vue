<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import UButton from '@nuxt/ui/components/Button.vue'
import UFieldGroup from '@nuxt/ui/components/FieldGroup.vue'
import UFormField from '@nuxt/ui/components/FormField.vue'
import UInputMenu from '@nuxt/ui/components/InputMenu.vue'
import UAlert from '@nuxt/ui/components/Alert.vue'
import USwitch from '@nuxt/ui/components/Switch.vue'
import UIcon from '@nuxt/ui/components/Icon.vue'
import type { useContentFontEditor } from '../../composables/settings/content-font-editor'

// A view of the settings dialog's font draft; it owns no lifecycle of its own.
defineProps<{ editor: ReturnType<typeof useContentFontEditor> }>()
const { t, n } = useI18n()
const field = { root: 'items-center gap-4', labelWrapper: 'justify-start', description: 'text-xs' }
</script>

<template>
  <form class="grid gap-4" @submit.prevent>
    <ol class="grid gap-2" :aria-label="t('settings.fontOrder')">
      <li
        v-for="(entry, index) in editor.draft.stack"
        :key="editor.entryIds[index]"
        class="font-stack-entry flex min-w-0 flex-wrap items-center justify-end gap-2"
      >
        <span
          class="w-3 shrink-0 text-center text-xs tabular-nums text-dimmed"
          :title="t(index === 0 ? 'settings.primaryFont' : 'settings.fallbackFont')"
          >{{ n(index + 1) }}</span
        >
        <UInputMenu
          :model-value="entry.family"
          mode="autocomplete"
          :items="editor.families"
          :open-on-focus="false"
          color="neutral"
          class="min-w-[min(100%,15rem)] flex-1"
          :aria-label="t('settings.font', { index: n(index + 1) })"
          :title="entry.family"
          :placeholder="t('settings.fontPlaceholder')"
          :maxlength="100"
          @update:model-value="editor.setFamily(index, $event)"
          ><template #empty>{{ t('settings.localFont') }}</template></UInputMenu
        >
        <UFieldGroup>
          <UButton
            type="button"
            color="neutral"
            variant="ghost"
            icon="i-lucide-chevron-up"
            :disabled="index === 0"
            :aria-label="t('settings.moveFontUp', { index: n(index + 1) })"
            @click="editor.moveFont(index, -1)"
          />
          <UButton
            type="button"
            color="neutral"
            variant="ghost"
            icon="i-lucide-chevron-down"
            :disabled="index === editor.draft.stack.length - 1"
            :aria-label="t('settings.moveFontDown', { index: n(index + 1) })"
            @click="editor.moveFont(index, 1)"
          />
          <UButton
            type="button"
            color="neutral"
            variant="ghost"
            icon="i-lucide-x"
            :disabled="editor.draft.stack.length === 1"
            :aria-label="t('settings.deleteFont', { index: n(index + 1) })"
            @click="editor.removeFont(index)"
          />
        </UFieldGroup>
      </li>
    </ol>
    <UButton
      type="button"
      color="neutral"
      variant="outline"
      size="sm"
      icon="i-lucide-plus"
      class="justify-self-start"
      :disabled="editor.draft.stack.length >= 12"
      :aria-label="t('settings.addFont')"
      @click="editor.addFont"
      >{{ t('settings.add') }}</UButton
    >
    <UFormField :label="t('settings.ligatures')" orientation="horizontal" :ui="field">
      <USwitch
        :model-value="editor.draft.ligatures"
        :aria-label="t('settings.ligatures')"
        @update:model-value="editor.setLigatures"
      />
    </UFormField>
    <UFormField
      :label="t('settings.preview')"
      :ui="{ labelWrapper: 'justify-start gap-2', hint: 'text-xs' }"
    >
      <template v-if="editor.loading || editor.saving" #hint
        ><span class="font-loading inline-flex items-center gap-1.5" role="status"
          ><UIcon name="i-lucide-loader-circle" class="size-3 animate-spin" />{{
            t(editor.saving ? 'settings.applying' : 'settings.loadingFont')
          }}</span
        ></template
      >
      <pre
        class="font-preview"
        :style="editor.previewStyle"
        :aria-busy="editor.loading"
        :aria-label="t('settings.fontPreview')"
        >{{ editor.previewText }}</pre>
    </UFormField>
    <UAlert
      v-if="editor.fontError"
      color="error"
      variant="subtle"
      :title="editor.fontErrorMessage"
      role="alert"
      :actions="[
        {
          label: t('common.retry'),
          color: 'error',
          variant: 'link',
          onClick: editor.retryPreview,
        },
      ]"
    />
  </form>
</template>

<style scoped>
.font-preview {
  margin: 0;
  padding: 12px;
  min-height: 108px;
  overflow: auto;
  border: 1px solid var(--ui-border);
  border-radius: calc(var(--ui-radius) * 1.5);
  background: var(--ui-bg-muted);
  color: var(--ui-text-highlighted);
  font-family: var(--content-font-family);
  font-size: 13px;
  line-height: 1.6;
  white-space: pre;
  tab-size: 4;
}
</style>
