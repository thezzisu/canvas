<script setup lang="ts">
import { onBeforeUnmount } from 'vue'
import { PreviewTap } from '../preview-tap'

defineProps<{ label: string }>()
const emit = defineEmits<{ open: [] }>()
const tap = new PreviewTap()
let pointer: number | undefined
function cancel() { pointer = undefined; tap.cancel(); document.removeEventListener('pointerdown', otherPointer, true) }
function otherPointer(event: PointerEvent) { if (pointer !== undefined && event.pointerId !== pointer) cancel() }
function down(event: PointerEvent) {
  tap.down(event, performance.now()); pointer = event.pointerId
  document.addEventListener('pointerdown', otherPointer, true)
}
function up(event: PointerEvent) {
  tap.up(event, performance.now()); pointer = undefined
  document.removeEventListener('pointerdown', otherPointer, true)
}
function click(event: MouseEvent) { if (tap.click(event.detail)) emit('open') }
onBeforeUnmount(cancel)
</script>

<template>
  <div class="card-preview-button" role="button" tabindex="0" :aria-label="label"
    @pointerdown="down" @pointermove="tap.move($event)" @pointerup="up" @pointercancel="cancel"
    @click.stop.prevent="click" @keydown.enter.stop.prevent="emit('open')" @keydown.space.stop.prevent="emit('open')" />
</template>
