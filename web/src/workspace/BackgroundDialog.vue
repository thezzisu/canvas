<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, onBeforeUnmount, ref, useTemplateRef } from 'vue'
import UModal from '../components/CanvasModal.vue'
import UAlert from '@nuxt/ui/components/Alert.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UFormField from '@nuxt/ui/components/FormField.vue'
import UIcon from '@nuxt/ui/components/Icon.vue'
import USlider from '@nuxt/ui/components/Slider.vue'
import { api, segment, write } from '../api/api'
import type { Canvas } from '../api/types'
import { useBackgroundUrl } from './backgrounds'

const { t, n } = useI18n()

const props = defineProps<{ canvas: Canvas }>()
const emit = defineEmits<{ close: []; saved: [canvas: Canvas] }>()
const picker = useTemplateRef('picker')
const chooseButton = useTemplateRef('chooseButton')
const file = ref<File | null>(null)
const objectUrl = ref('')
const removed = ref(false)
const opacity = ref(props.canvas.background?.opacity ?? 0.35)
const saving = ref(false)
const inspecting = ref(false)
const error = ref<string | Error>('')
let selection = 0
let disposed = false
const { url: backgroundUrl } = useBackgroundUrl(() => props.canvas.background?.url)
const preview = computed(() => (removed.value ? '' : objectUrl.value || backgroundUrl.value))
const opacityLabel = computed(() =>
  n(opacity.value, { style: 'percent', maximumFractionDigits: 0 }),
)
const changed = computed(
  () =>
    !!file.value ||
    (!!props.canvas.background &&
      (removed.value || opacity.value !== props.canvas.background.opacity)),
)

function clearObjectUrl() {
  if (objectUrl.value) URL.revokeObjectURL(objectUrl.value)
  objectUrl.value = ''
}
async function chooseFile(event: Event) {
  const input = event.target as HTMLInputElement
  const chosen = input.files?.[0]
  input.value = ''
  if (!chosen) return
  const request = ++selection
  error.value = ''
  inspecting.value = false
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(chosen.type)) {
    error.value = 'panels.background.invalidType'
    return
  }
  inspecting.value = true
  const url = URL.createObjectURL(chosen)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    if (!image.naturalWidth || !image.naturalHeight) throw new Error()
    if (disposed || request !== selection) {
      URL.revokeObjectURL(url)
      return
    }
    clearObjectUrl()
    objectUrl.value = url
    file.value = chosen
    removed.value = false
  } catch {
    URL.revokeObjectURL(url)
    if (!disposed && request === selection) error.value = 'panels.background.unreadable'
  } finally {
    if (request === selection) inspecting.value = false
  }
}
function remove() {
  selection++
  clearObjectUrl()
  file.value = null
  removed.value = true
  error.value = ''
  inspecting.value = false
}
async function save() {
  if (!changed.value || saving.value || inspecting.value) return
  saving.value = true
  error.value = ''
  const path = `/api/canvases/${segment(props.canvas.id)}/background`
  try {
    const canvas = file.value
      ? await api<Canvas>(`${path}?opacity=${opacity.value}`, {
          method: 'PUT',
          headers: { 'Content-Type': file.value.type },
          body: file.value,
        })
      : await write<Canvas>(
          path,
          removed.value ? 'DELETE' : 'PATCH',
          removed.value ? undefined : { opacity: opacity.value },
        )
    emit('saved', canvas)
    emit('close')
  } catch (reason) {
    error.value = reason instanceof Error ? reason : new Error(String(reason))
  } finally {
    saving.value = false
  }
}
function close() {
  if (!saving.value) emit('close')
}
onBeforeUnmount(() => {
  disposed = true
  selection++
  clearObjectUrl()
})
</script>

<template>
  <UModal
    :open="true"
    :title="t('panels.background.title')"
    :dismissible="!saving"
    :close="{ 'aria-label': t('common.close'), disabled: saving }"
    :ui="{ content: 'background-modal [--dialog-width:30rem]' }"
    :content="{
      onOpenAutoFocus: (event: Event) => {
        event.preventDefault()
        chooseButton?.$el?.focus()
      },
    }"
    @update:open="
      (value) => {
        if (!value) close()
      }
    "
  >
    <template #body>
      <div class="flex flex-col gap-4" :aria-busy="saving">
        <div class="background-preview" :class="{ 'has-image': preview }">
          <img
            v-if="preview"
            :src="preview"
            :style="{ opacity }"
            :alt="t('panels.background.preview')"
          />
          <UIcon v-else name="i-lucide-image" class="size-8" />
        </div>
        <input
          ref="picker"
          class="hidden"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          tabindex="-1"
          :aria-label="t('panels.background.choose')"
          :disabled="saving"
          @change="chooseFile"
        />
        <div class="flex flex-wrap items-center gap-2">
          <UButton
            ref="chooseButton"
            color="neutral"
            variant="outline"
            size="sm"
            icon="i-lucide-image"
            :loading="inspecting"
            :disabled="saving"
            @click="picker?.click()"
            >{{ t(preview ? 'panels.background.change' : 'panels.background.choose') }}</UButton
          >
          <UButton
            v-if="preview"
            color="neutral"
            variant="ghost"
            size="sm"
            :disabled="saving || inspecting"
            @click="remove"
            >{{ t('panels.background.remove') }}</UButton
          >
          <span class="ms-auto text-xs text-dimmed">PNG / JPEG / WebP</span>
        </div>
        <UFormField v-if="preview" :label="t('panels.background.opacity')" :hint="opacityLabel">
          <USlider
            v-model="opacity"
            class="w-full"
            :min="0"
            :max="1"
            :step="0.05"
            size="sm"
            :disabled="saving"
            :aria-label="t('panels.background.opacityLabel')"
            :aria-valuetext="opacityLabel"
          />
        </UFormField>
        <UAlert
          v-if="error"
          color="error"
          variant="subtle"
          :title="error instanceof Error ? error.message : t(error)"
          role="alert"
          class="[overflow-wrap:anywhere]"
        />
      </div>
    </template>
    <template #footer>
      <UButton color="neutral" variant="outline" :disabled="saving" @click="close">{{
        t('common.cancel')
      }}</UButton>
      <UButton :loading="saving" :disabled="!changed || inspecting" @click="save">{{
        t('common.save')
      }}</UButton>
    </template>
  </UModal>
</template>
