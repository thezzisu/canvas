<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useDocumentVisibility } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import UModal from './CanvasModal.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UIcon from '@nuxt/ui/components/Icon.vue'
import type QrScanner from 'qr-scanner'

const props = defineProps<{ open: boolean; accept: (text: string) => boolean; portal?: HTMLElement }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const visibility = useDocumentVisibility()
const video = ref<HTMLVideoElement>(), fileInput = ref<HTMLInputElement>()
const reading = ref(false), error = ref(''), camera = ref<'starting' | 'active' | 'failed'>('starting'), attempt = ref(0)
const secureContext = window.isSecureContext
const cameraAvailable = secureContext && !!navigator.mediaDevices?.getUserMedia
const cameraVisible = computed(() => props.open && visibility.value === 'visible' && !reading.value && cameraAvailable)
let fileAttempt = 0, accepted = false

function receive(text: string) {
  if (!props.open || visibility.value !== 'visible' || accepted) return
  if (props.accept(text)) { accepted = true; emit('close') }
  else error.value = 'instances.invalidQr'
}

watch([() => props.open, visibility], () => {
  fileAttempt++; reading.value = false
  if (props.open) { error.value = ''; accepted = false }
}, { flush: 'sync' })

watch([cameraVisible, video, attempt], async ([visible, element], _previous, cleanup) => {
  let cancelled = false, scanner: QrScanner | undefined
  cleanup(() => { cancelled = true; if (scanner) { void scanner.pause(true); scanner.destroy() } })
  if (!visible || !element) return
  camera.value = 'starting'
  try {
    const { default: Scanner } = await import('qr-scanner')
    if (cancelled) return
    scanner = new Scanner(element, result => { if (!cancelled && !reading.value) receive(result.data) }, {
      preferredCamera: 'environment', maxScansPerSecond: 5,
      calculateScanRegion: target => {
        const size = Math.min(target.videoWidth, target.videoHeight)
        return { x: (target.videoWidth - size) / 2, y: (target.videoHeight - size) / 2, width: size, height: size, downScaledWidth: 640, downScaledHeight: 640 }
      },
      returnDetailedScanResult: true,
    })
    await scanner.start()
    if (!cancelled) camera.value = 'active'
  } catch {
    if (!cancelled) { camera.value = 'failed'; if (scanner) { void scanner.pause(true); scanner.destroy() } }
  }
}, { flush: 'post' })

async function readImage(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]
  input.value = ''
  if (!file) return
  const id = ++fileAttempt
  reading.value = true; error.value = ''
  try {
    const { default: Scanner } = await import('qr-scanner')
    if (id !== fileAttempt || !props.open) return
    const result = await Scanner.scanImage(file, { returnDetailedScanResult: true })
    if (id === fileAttempt) receive(result.data)
  } catch { if (id === fileAttempt && props.open) error.value = 'instances.qrNotFound' }
  finally { if (id === fileAttempt) reading.value = false }
}
onBeforeUnmount(() => { fileAttempt++ })
</script>

<template>
  <UModal :open="open" :portal="portal || false" :title="t('instances.scanQr')" :close="{ 'aria-label': t('common.close') }"
    :ui="{ content: 'instance-qr-dialog', overlay: 'instance-qr-overlay' }" @update:open="value => { if (!value) emit('close') }">
    <template #body>
      <div class="instance-qr-body">
        <div v-if="cameraAvailable" class="instance-qr-camera">
          <video v-if="cameraVisible" :key="attempt" ref="video" autoplay muted playsinline :aria-label="t('instances.cameraPreview')" />
          <div v-if="camera !== 'active' || reading" class="instance-qr-camera-status" role="status">
            <UIcon :name="camera === 'failed' ? 'i-lucide-camera-off' : 'i-lucide-scan-qr-code'" />
            <span>{{ reading ? t('instances.readingQr') : camera === 'failed' ? t('instances.cameraUnavailable') : t('common.loading') }}</span>
          </div>
        </div>
        <p v-else class="instance-qr-hint">{{ t(secureContext ? 'instances.cameraUnavailable' : 'instances.cameraHttps') }}</p>
        <p v-if="error" class="instance-qr-error" role="alert">{{ t(error) }}</p>
      </div>
    </template>
    <template #footer>
      <div class="instance-qr-actions">
        <input ref="fileInput" class="file-input" type="file" accept="image/*" :aria-label="t('instances.chooseQrImage')" @change="readImage" />
        <UButton type="button" color="neutral" variant="outline" icon="i-lucide-image" :loading="reading" @click="fileInput?.click()">{{ t('instances.chooseQrImage') }}</UButton>
        <UButton v-if="cameraAvailable && camera === 'failed'" type="button" color="neutral" variant="ghost" icon="i-lucide-camera" :aria-label="t('instances.useCamera')" @click="attempt++; error = ''">{{ t('common.retry') }}</UButton>
      </div>
    </template>
  </UModal>
</template>

<style>
.instance-qr-overlay{z-index:95}.instance-qr-dialog{z-index:96;--qr-safe-top:max(16px,var(--ui-safe-top));--qr-safe-bottom:max(16px,var(--ui-safe-bottom));top:calc((var(--mobile-height,var(--ui-viewport-height)) + var(--qr-safe-top) - var(--qr-safe-bottom))/2);width:min(420px,calc(var(--mobile-width,var(--ui-viewport-width)) - 28px));max-height:calc(var(--mobile-height,var(--ui-viewport-height)) - var(--qr-safe-top) - var(--qr-safe-bottom))}
.instance-qr-body{display:flex;flex-direction:column;gap:12px}.instance-qr-camera{position:relative;overflow:hidden;aspect-ratio:1;border:1px solid var(--border);border-radius:8px;background:#101216}
.instance-qr-camera video{display:block;width:100%;height:100%;object-fit:cover}.instance-qr-camera-status{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:#96a0af;font-size:12px;background:#101216}
.instance-qr-camera-status>span:first-child{width:30px;height:30px}.instance-qr-hint,.instance-qr-error{margin:0;font-size:12px;line-height:1.5}.instance-qr-hint{color:#96a0af}.instance-qr-error{color:#e0aaa5}.instance-qr-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%}
</style>
