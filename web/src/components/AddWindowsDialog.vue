<script setup lang="ts">
import { computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import UModal from './CanvasModal.vue'
import UAlert from '@nuxt/ui/components/Alert.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UForm from '@nuxt/ui/components/Form.vue'
import UFormField from '@nuxt/ui/components/FormField.vue'
import UIcon from '@nuxt/ui/components/Icon.vue'
import UInput from '@nuxt/ui/components/Input.vue'
import USelect from '@nuxt/ui/components/Select.vue'
import WindowPickerTree from './WindowPickerTree.vue'
import type { Canvas, Source, SourceResource } from '../types'

// Picks windows and a destination; App owns the selection and the write.
const props = defineProps<{ canvases: Canvas[]; sources: Source[]; resources: SourceResource[]; existing: Set<string>; count: number
  loading: boolean; loadFailed: boolean; loaded: boolean; fresh: boolean; busy: boolean; error: string }>()
const emit = defineEmits<{ close: []; submit: [] }>()
const target = defineModel<string>('target', { required: true })
const search = defineModel<string>('search', { required: true })
const selected = defineModel<string[]>('selected', { required: true })
const { t } = useI18n()
const formId = useId()
// An empty target creates a new canvas; Select items cannot carry an empty value.
const create = 'new'
const destination = computed({ get: () => target.value || create, set: value => { target.value = value === create ? '' : value } })
// Enter in the search only filters; the footer action adds the selection. IME commits pass through.
function keepSearching(event: KeyboardEvent) { if (!event.isComposing) event.preventDefault() }
const destinations = computed(() => [props.canvases.map(canvas => ({ label: canvas.name, value: canvas.id })), [{ label: t('app.newMyCanvas'), value: create }]].filter(group => group.length))
</script>

<template>
  <UModal :open="true" :title="t('app.addWindows')" :dismissible="!busy"
    :close="{ 'aria-label': t('app.closeDialog'), disabled: busy }" :ui="{ content: 'add-modal [--dialog-width:36rem]' }" @update:open="value => { if (!value) emit('close') }">
    <template #body>
      <UForm :id="formId" :disabled="busy" class="flex flex-col gap-4" @submit="emit('submit')">
        <UFormField :label="t('app.targetCanvas')"><USelect v-model="destination" name="targetCanvas" :items="destinations" class="w-full" /></UFormField>
        <UInput v-model="search" icon="i-lucide-search" :aria-label="t('app.searchWindows')" :placeholder="t('app.searchPlaceholder')" class="w-full" @keydown.enter="keepSearching" />
        <p v-if="loading" class="flex items-center justify-center gap-1.5 py-6 text-xs text-muted" role="status">
          <UIcon v-if="!loadFailed" name="i-lucide-loader-circle" class="size-3.5 motion-safe:animate-spin" />{{ t(loadFailed ? 'app.loadFailed' : 'common.loading') }}
        </p>
        <WindowPickerTree v-if="loaded" v-model:selected="selected" :fresh="fresh" :sources="sources" :resources="resources" :query="search" :existing="existing" />
        <UAlert v-if="error" color="error" variant="subtle" :title="error" role="alert" class="[overflow-wrap:anywhere]" />
      </UForm>
    </template>
    <template #footer>
      <span class="min-w-0 flex-1 truncate text-xs text-muted">{{ t('app.selectedWindows', count) }}</span>
      <UButton color="neutral" variant="outline" :disabled="busy" @click="emit('close')">{{ t('common.cancel') }}</UButton>
      <UButton type="submit" :form="formId" :loading="busy" :disabled="!count">{{ t('app.addToCanvas') }}</UButton>
    </template>
  </UModal>
</template>
