<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import Icon from './Icon.vue'

const { t, n } = useI18n()

const props = defineProps<{ id: string; src: string; alt: string; readOnly?: boolean }>()
const emit = defineEmits<{ loaded: [id: string, width: number, height: number]; failed: [id: string] }>()
const viewport = ref<HTMLElement>()
const natural = ref({ width: 0, height: 0 })
const bounds = ref({ width: 0, height: 0 })
const scale = ref(1)
const pan = ref({ x: 0, y: 0 })
const fitted = ref(true)
const dragging = ref(false)
const ready = computed(() => natural.value.width > 0 && bounds.value.width > 0 && bounds.value.height > 0)
const fitScale = computed(() => ready.value ? Math.min(1, bounds.value.width / natural.value.width, bounds.value.height / natural.value.height) : 1)
const minimumScale = computed(() => Math.min(.05, fitScale.value))
const maximumScale = 8
const percentage = computed(() => n(scale.value, { style: 'percent', maximumFractionDigits: scale.value < .1 ? 1 : 0 }))
const canPan = computed(() => ready.value && (natural.value.width * scale.value > bounds.value.width + 1 || natural.value.height * scale.value > bounds.value.height + 1))
const imageStyle = computed(() => ({
  width: `${natural.value.width * scale.value}px`, height: `${natural.value.height * scale.value}px`,
  transform: `translate(${pan.value.x}px, ${pan.value.y}px) translate(-50%, -50%)`,
  visibility: ready.value ? 'visible' as const : 'hidden' as const,
}))
type Point = { x: number; y: number }
const pointers = new Map<number, Point>()
let gesture: { center: Point; distance: number; scale: number; pan: Point; count: number } | undefined
let observer: ResizeObserver | undefined
let disposed = false
let suppressDoubleClickUntil = 0
let lastTouchTap: { at: number; point: Point } | undefined
let touchStart: { id: number; at: number; point: Point; moved: boolean } | undefined

function clampPan(value: Point, zoom = scale.value): Point {
  const maxX = Math.max(0, (natural.value.width * zoom - bounds.value.width) / 2)
  const maxY = Math.max(0, (natural.value.height * zoom - bounds.value.height) / 2)
  return { x: Math.min(maxX, Math.max(-maxX, value.x)), y: Math.min(maxY, Math.max(-maxY, value.y)) }
}
function localPoint(clientX: number, clientY: number): Point {
  const element = viewport.value!, box = element.getBoundingClientRect()
  return { x: (clientX - box.left) * element.clientWidth / box.width - element.clientWidth / 2,
    y: (clientY - box.top) * element.clientHeight / box.height - element.clientHeight / 2 }
}
function position() {
  const points = [...pointers.values()]
  const a = points[0]!, b = points[1]
  return { center: b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : a,
    distance: b ? Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) : 1, count: points.length }
}
function rebase() {
  gesture = pointers.size ? { ...position(), scale: scale.value, pan: { ...pan.value } } : undefined
  dragging.value = !!gesture && (canPan.value || pointers.size > 1)
}
function clearPointers() {
  const ids = [...pointers.keys()]
  pointers.clear(); gesture = undefined; touchStart = undefined; lastTouchTap = undefined; dragging.value = false
  for (const id of ids) if (viewport.value?.hasPointerCapture(id)) viewport.value.releasePointerCapture(id)
}
function fit() {
  clearPointers()
  lastTouchTap = undefined
  fitted.value = true
  scale.value = fitScale.value
  pan.value = { x: 0, y: 0 }
}
function resize() {
  const element = viewport.value
  if (disposed || !element?.clientWidth || !element.clientHeight) return
  if (element.clientWidth !== bounds.value.width || element.clientHeight !== bounds.value.height) { clearPointers(); lastTouchTap = undefined }
  bounds.value = { width: element.clientWidth, height: element.clientHeight }
  if (fitted.value) { scale.value = fitScale.value; pan.value = { x: 0, y: 0 } }
  else pan.value = clampPan(pan.value)
  rebase()
}
function loaded(event: Event) {
  const image = event.currentTarget as HTMLImageElement
  if (disposed || image.dataset.previewId !== props.id || !image.naturalWidth || !image.naturalHeight) return
  natural.value = { width: image.naturalWidth, height: image.naturalHeight }
  resize(); fit()
  emit('loaded', props.id, image.naturalWidth, image.naturalHeight)
}
function failed(event: Event) {
  if (!disposed && (event.currentTarget as HTMLImageElement).dataset.previewId === props.id) emit('failed', props.id)
}
function zoom(value: number, anchor: Point = { x: 0, y: 0 }) {
  if (!ready.value || !Number.isFinite(value)) return
  const next = Math.min(maximumScale, Math.max(minimumScale.value, value))
  const ratio = next / scale.value
  pan.value = clampPan({ x: anchor.x - (anchor.x - pan.value.x) * ratio, y: anchor.y - (anchor.y - pan.value.y) * ratio }, next)
  scale.value = next; fitted.value = false
  rebase()
}
function wheel(event: WheelEvent) {
  if (props.readOnly) return
  event.preventDefault(); event.stopPropagation()
  const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.value.height : 1)
  if (!delta) return
  zoom(scale.value * Math.exp(Math.max(-1, Math.min(1, -delta * .002))), localPoint(event.clientX, event.clientY))
}
function pointerDown(event: PointerEvent) {
  if (props.readOnly || !ready.value || event.button !== 0) return
  event.preventDefault(); event.stopPropagation()
  const point = localPoint(event.clientX, event.clientY)
  pointers.set(event.pointerId, point)
  viewport.value?.setPointerCapture(event.pointerId)
  if (event.pointerType === 'touch' && pointers.size === 1) touchStart = { id: event.pointerId, at: performance.now(), point, moved: false }
  else { touchStart = undefined; lastTouchTap = undefined }
  rebase()
}
function pointerMove(event: PointerEvent) {
  if (!pointers.has(event.pointerId) || !gesture) return
  event.preventDefault(); event.stopPropagation()
  const point = localPoint(event.clientX, event.clientY)
  pointers.set(event.pointerId, point)
  if (touchStart && Math.hypot(point.x - touchStart.point.x, point.y - touchStart.point.y) > 6) { touchStart.moved = true; lastTouchTap = undefined }
  const current = position()
  const distance = Math.hypot(current.center.x - gesture.center.x, current.center.y - gesture.center.y)
  if (distance > 3 || current.count > 1) suppressDoubleClickUntil = performance.now() + 350
  if (current.count > 1) {
    const next = Math.max(minimumScale.value, Math.min(maximumScale, gesture.scale * current.distance / gesture.distance))
    const ratio = next / gesture.scale
    scale.value = next
    pan.value = clampPan({ x: current.center.x - (gesture.center.x - gesture.pan.x) * ratio, y: current.center.y - (gesture.center.y - gesture.pan.y) * ratio }, next)
    fitted.value = false
  } else if (canPan.value) {
    pan.value = clampPan({ x: gesture.pan.x + current.center.x - gesture.center.x, y: gesture.pan.y + current.center.y - gesture.center.y })
    fitted.value = false
  }
}
function toggleZoom(point: Point) {
  if (!fitted.value) fit()
  else zoom(Math.min(maximumScale, Math.max(1, fitScale.value * 2)), point)
}
function pointerEnd(event: PointerEvent, cancelled = false) {
  if (!pointers.has(event.pointerId)) return
  event.preventDefault(); event.stopPropagation()
  const tap = touchStart?.id === event.pointerId ? touchStart : undefined
  pointers.delete(event.pointerId)
  if (viewport.value?.hasPointerCapture(event.pointerId)) viewport.value.releasePointerCapture(event.pointerId)
  touchStart = undefined
  rebase()
  if (cancelled) { lastTouchTap = undefined; return }
  if (tap && !tap.moved && performance.now() - tap.at < 300) {
    const now = performance.now()
    if (lastTouchTap && now - lastTouchTap.at < 320 && Math.hypot(tap.point.x - lastTouchTap.point.x, tap.point.y - lastTouchTap.point.y) < 24) {
      toggleZoom(tap.point); lastTouchTap = undefined; suppressDoubleClickUntil = now + 500
    } else lastTouchTap = { at: now, point: tap.point }
  }
}
function doubleClick(event: MouseEvent) {
  if (props.readOnly) return
  event.preventDefault(); event.stopPropagation()
  if (performance.now() >= suppressDoubleClickUntil) toggleZoom(localPoint(event.clientX, event.clientY))
}
function hidden() { if (document.hidden) clearPointers() }
onMounted(() => {
  observer = new ResizeObserver(resize)
  if (viewport.value) observer.observe(viewport.value)
  resize()
  window.addEventListener('blur', clearPointers)
  document.addEventListener('visibilitychange', hidden)
})
onBeforeUnmount(() => {
  disposed = true; clearPointers(); observer?.disconnect()
  window.removeEventListener('blur', clearPointers)
  document.removeEventListener('visibilitychange', hidden)
})
</script>

<template>
  <div class="image-preview-viewer">
    <div ref="viewport" class="image-preview-viewport" :class="{ 'can-pan': canPan, dragging }" :data-scale="scale" :data-fit="fitted" :data-pan-x="pan.x" :data-pan-y="pan.y"
      @wheel="wheel" @pointerdown="pointerDown" @pointermove="pointerMove" @pointerup="pointerEnd" @pointercancel="pointerEnd($event, true)" @lostpointercapture="pointerEnd($event, true)" @dblclick="doubleClick" @dragstart.prevent @contextmenu.prevent>
      <img class="download-preview-image" :data-preview-id="id" :src="src" :alt="alt" :style="imageStyle" draggable="false" @load="loaded" @error="failed" />
    </div>
    <div v-if="ready && !readOnly" class="image-preview-tools" role="toolbar" :aria-label="t('panels.image.zoom')" @pointerdown.stop @mousedown.prevent.stop @dblclick.stop>
      <button type="button" :aria-label="t('panels.image.zoomOut')" :title="t('panels.image.zoomOut')" :disabled="scale <= minimumScale + .00001" @click="zoom(scale / 1.25)"><Icon name="minus" :size="16" /></button>
      <button type="button" :aria-label="t('panels.image.fit')" :title="t('panels.image.fit')" @click="fit"><Icon name="fit" :size="16" /></button>
      <output class="image-preview-scale" :aria-label="t('panels.image.scale')">{{ percentage }}</output>
      <button type="button" :aria-label="t('panels.image.zoomIn')" :title="t('panels.image.zoomIn')" :disabled="scale >= maximumScale" @click="zoom(scale * 1.25)"><Icon name="plus" :size="16" /></button>
    </div>
  </div>
</template>

<style scoped>
.image-preview-viewer{position:relative;display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;width:100%;overflow:hidden}
.image-preview-viewport{position:relative;flex:1;min-width:0;min-height:0;overflow:hidden;touch-action:none;user-select:none;-webkit-user-select:none;cursor:zoom-in}
.image-preview-viewport.can-pan{cursor:grab}.image-preview-viewport.dragging{cursor:grabbing}
.download-preview-image{position:absolute;left:50%;top:50%;display:block;max-width:none;max-height:none;flex:none;object-fit:fill;user-select:none;-webkit-user-select:none;-webkit-user-drag:none;pointer-events:none;transform-origin:0 0}
.image-preview-tools{display:flex;flex:0 0 40px;align-items:center;justify-content:center;gap:3px;height:40px;padding:3px;border-top:1px solid #303947;background:#191f27;color:#bdc9d8;touch-action:manipulation}
.image-preview-tools button{display:flex;align-items:center;justify-content:center;width:32px;min-width:32px;height:32px;padding:0;border:0;border-radius:4px;background:transparent;color:inherit}
.image-preview-tools button:hover:not(:disabled){background:#ffffff0d;color:#e5c9b3}.image-preview-tools button:disabled{opacity:.35;cursor:default}
.image-preview-tools button:focus-visible{outline:1px solid #d4ac8e;outline-offset:0}
.image-preview-scale{min-width:39px;padding:0 3px;font-size:10px;font-variant-numeric:tabular-nums;text-align:center;color:#a1afc0}
@media(pointer:coarse){.image-preview-tools button{width:38px;min-width:38px;height:34px}}
</style>
