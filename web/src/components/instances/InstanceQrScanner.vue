<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useDocumentVisibility } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import UAlert from '@nuxt/ui/components/Alert.vue'
import UModal from '../CanvasModal.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UIcon from '@nuxt/ui/components/Icon.vue'
import type QrScanner from 'qr-scanner'

const props = defineProps<{ open: boolean; accept: (text: string) => boolean }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const visibility = useDocumentVisibility()
const video = ref<HTMLVideoElement>(),
  fileInput = ref<HTMLInputElement>()
const reading = ref(false),
  error = ref(''),
  camera = ref<'starting' | 'active' | 'failed'>('starting'),
  attempt = ref(0)
const secureContext = window.isSecureContext
const cameraAvailable = secureContext && !!navigator.mediaDevices?.getUserMedia
const cameraVisible = computed(
  () => props.open && visibility.value === 'visible' && !reading.value && cameraAvailable,
)
let fileAttempt = 0,
  accepted = false

function receive(text: string) {
  if (!props.open || visibility.value !== 'visible' || accepted) return
  if (props.accept(text)) {
    accepted = true
    emit('close')
  } else error.value = 'instances.invalidQr'
}

watch(
  [() => props.open, visibility],
  () => {
    fileAttempt++
    reading.value = false
    if (props.open) {
      error.value = ''
      accepted = false
    }
  },
  { flush: 'sync' },
)

function retryCamera() {
  attempt.value++
  error.value = ''
}
watch(
  [cameraVisible, video, attempt],
  async ([visible, element], _previous, cleanup) => {
    let cancelled = false,
      scanner: QrScanner | undefined
    cleanup(() => {
      cancelled = true
      if (scanner) {
        void scanner.pause(true)
        scanner.destroy()
      }
    })
    if (!visible || !element) return
    camera.value = 'starting'
    try {
      const { default: Scanner } = await import('qr-scanner')
      if (cancelled) return
      scanner = new Scanner(
        element,
        (result) => {
          if (!cancelled && !reading.value) receive(result.data)
        },
        {
          preferredCamera: 'environment',
          maxScansPerSecond: 5,
          calculateScanRegion: (target) => {
            const size = Math.min(target.videoWidth, target.videoHeight)
            return {
              x: (target.videoWidth - size) / 2,
              y: (target.videoHeight - size) / 2,
              width: size,
              height: size,
              downScaledWidth: 640,
              downScaledHeight: 640,
            }
          },
          returnDetailedScanResult: true,
        },
      )
      await scanner.start()
      if (!cancelled) camera.value = 'active'
    } catch {
      if (!cancelled) {
        camera.value = 'failed'
        if (scanner) {
          void scanner.pause(true)
          scanner.destroy()
        }
      }
    }
  },
  { flush: 'post' },
)

async function readImage(event: Event) {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0]
  input.value = ''
  if (!file) return
  const id = ++fileAttempt
  reading.value = true
  error.value = ''
  try {
    const { default: Scanner } = await import('qr-scanner')
    if (id !== fileAttempt || !props.open) return
    const result = await Scanner.scanImage(file, { returnDetailedScanResult: true })
    if (id === fileAttempt) receive(result.data)
  } catch {
    if (id === fileAttempt && props.open) error.value = 'instances.qrNotFound'
  } finally {
    if (id === fileAttempt) reading.value = false
  }
}
onBeforeUnmount(() => {
  fileAttempt++
})
</script>

<template>
  <UModal
    v-if="open"
    :open="true"
    :title="t('instances.scanQr')"
    :ui="{ content: 'instance-qr-dialog [--dialog-width:420px]' }"
    @update:open="
      (value) => {
        if (!value) emit('close')
      }
    "
  >
    <template #body>
      <div class="flex flex-col gap-3">
        <div
          v-if="cameraAvailable"
          class="instance-qr-camera relative aspect-square overflow-hidden rounded-md bg-muted ring ring-default"
        >
          <video
            v-if="cameraVisible"
            :key="attempt"
            ref="video"
            class="block size-full object-cover"
            autoplay
            muted
            playsinline
            :aria-label="t('instances.cameraPreview')"
          />
          <div
            v-if="camera !== 'active' || reading"
            class="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-muted text-sm text-muted"
            role="status"
          >
            <UIcon
              :name="camera === 'failed' ? 'i-lucide-camera-off' : 'i-lucide-scan-qr-code'"
              class="size-8"
            />
            <span>{{
              reading
                ? t('instances.readingQr')
                : camera === 'failed'
                  ? t('instances.cameraUnavailable')
                  : t('common.loading')
            }}</span>
          </div>
        </div>
        <UAlert
          v-else
          color="neutral"
          variant="subtle"
          icon="i-lucide-camera-off"
          :title="t(secureContext ? 'instances.cameraUnavailable' : 'instances.cameraHttps')"
        />
        <UAlert v-if="error" color="error" variant="subtle" :title="t(error)" role="alert" />
      </div>
    </template>
    <template #footer>
      <input
        ref="fileInput"
        class="hidden"
        type="file"
        accept="image/*"
        :aria-label="t('instances.chooseQrImage')"
        @change="readImage"
      />
      <UButton
        v-if="cameraAvailable && camera === 'failed'"
        type="button"
        color="neutral"
        variant="ghost"
        icon="i-lucide-camera"
        :aria-label="t('instances.useCamera')"
        @click="retryCamera"
        >{{ t('common.retry') }}</UButton
      >
      <UButton
        type="button"
        color="neutral"
        variant="outline"
        icon="i-lucide-image"
        :loading="reading"
        @click="fileInput?.click()"
        >{{ t('instances.chooseQrImage') }}</UButton
      >
    </template>
  </UModal>
</template>
