<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { api, segment, write } from '../api'
import type { Canvas } from '../types'
import Icon from './Icon.vue'

const props = defineProps<{ canvas: Canvas }>()
const emit = defineEmits<{ close: []; saved: [canvas: Canvas] }>()
const dialog = ref<HTMLElement>()
const picker = ref<HTMLInputElement>()
const chooseButton = ref<HTMLButtonElement>()
const file = ref<File | null>(null)
const objectUrl = ref('')
const removed = ref(false)
const opacity = ref(props.canvas.background?.opacity ?? .35)
const saving = ref(false)
const inspecting = ref(false)
const error = ref('')
const originalFocus = document.activeElement as HTMLElement | null
let selection = 0
let disposed = false
const preview = computed(() => removed.value ? '' : objectUrl.value || props.canvas.background?.url || '')
const changed = computed(() => !!file.value || (!!props.canvas.background && (removed.value || opacity.value !== props.canvas.background.opacity)))

function clearObjectUrl() { if (objectUrl.value) URL.revokeObjectURL(objectUrl.value); objectUrl.value = '' }
async function chooseFile(event: Event) {
  const input = event.target as HTMLInputElement
  const chosen = input.files?.[0]
  input.value = ''
  if (!chosen) return
  const request = ++selection
  error.value = ''
  inspecting.value = false
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(chosen.type)) { error.value = '请选择 PNG、JPEG 或 WebP 图片'; return }
  inspecting.value = true
  const url = URL.createObjectURL(chosen)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('无法读取这张图片')
    if (disposed || request !== selection) { URL.revokeObjectURL(url); return }
    clearObjectUrl()
    objectUrl.value = url
    file.value = chosen
    removed.value = false
  } catch {
    URL.revokeObjectURL(url)
    if (!disposed && request === selection) error.value = '无法读取这张图片'
  } finally { if (request === selection) inspecting.value = false }
}
function remove() { selection++; clearObjectUrl(); file.value = null; removed.value = true; error.value = ''; inspecting.value = false }
async function save() {
  if (!changed.value || saving.value || inspecting.value) return
  saving.value = true; error.value = ''
  const path = `/api/canvases/${segment(props.canvas.id)}/background`
  try {
    const canvas = file.value
      ? await api<Canvas>(`${path}?opacity=${opacity.value}`, { method: 'PUT', headers: { 'Content-Type': file.value.type }, body: file.value })
      : await write<Canvas>(path, removed.value ? 'DELETE' : 'PATCH', removed.value ? undefined : { opacity: opacity.value })
    emit('saved', canvas)
    emit('close')
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { saving.value = false }
}
function close() { if (!saving.value) emit('close') }
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
  if (event.key !== 'Tab') return
  const elements = [...(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled):not([type="file"])') || [])]
  if (!elements.length) { event.preventDefault(); return }
  const first = elements[0], last = elements.at(-1)
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
}
onMounted(() => { void nextTick(() => chooseButton.value?.focus()) })
onBeforeUnmount(() => { disposed = true; selection++; clearObjectUrl(); originalFocus?.focus() })
</script>

<template>
  <div class="modal-backdrop" @click.self="close" @keydown="keydown">
    <section ref="dialog" class="modal background-modal" role="dialog" aria-modal="true" aria-labelledby="background-title" :aria-busy="saving">
      <header><h2 id="background-title">背景图片</h2><button class="icon-button" aria-label="关闭对话框" :disabled="saving" @click="close"><Icon name="close" /></button></header>
      <div class="background-preview" :class="{ 'has-image': preview }">
        <img v-if="preview" :src="preview" :style="{ opacity }" alt="背景预览" />
        <Icon v-else name="image" :size="28" />
      </div>
      <input ref="picker" class="file-input" type="file" accept="image/png,image/jpeg,image/webp" tabindex="-1" aria-label="选择背景图片" :disabled="saving" @change="chooseFile" />
      <div class="background-file-actions"><button ref="chooseButton" class="button subtle" :disabled="saving || inspecting" @click="picker?.click()"><Icon name="image" :size="15" />{{ inspecting ? '读取中…' : preview ? '更换图片' : '选择图片' }}</button><button v-if="preview" class="text-button" :disabled="saving || inspecting" @click="remove">移除</button><span>PNG / JPEG / WebP</span></div>
      <label v-if="preview" class="background-opacity"><span>不透明度<output>{{ Math.round(opacity * 100) }}%</output></span><input v-model.number="opacity" type="range" min="0" max="1" step="0.05" aria-label="背景不透明度" :disabled="saving" /></label>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <footer><button class="button subtle" :disabled="saving" @click="close">取消</button><button class="button primary" :disabled="!changed || saving || inspecting" @click="save"><span v-if="saving" class="spinner" />{{ saving ? '保存中…' : '保存' }}</button></footer>
    </section>
  </div>
</template>
