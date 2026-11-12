<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import UButton from '@nuxt/ui/components/Button.vue'
import { copyText } from '../../utils/clipboard'

const props = defineProps<{ link: string; name: string; base: string; username: string }>()
const { t } = useI18n()
const image = ref(''),
  failed = ref(false),
  retry = ref(0)

watch(
  [() => props.link, retry],
  async ([link], _, onCleanup) => {
    let current = true
    onCleanup(() => {
      current = false
    })
    image.value = ''
    failed.value = false
    try {
      const { toDataURL } = await import('qrcode')
      const data = await toDataURL(link, {
        errorCorrectionLevel: 'M',
        margin: 4,
        scale: 8,
        color: { dark: '#111111', light: '#ffffff' },
      })
      if (current) image.value = data
    } catch {
      if (current) failed.value = true
    }
  },
  { immediate: true },
)

function copy() {
  void copyText(props.link)
}
</script>

<template>
  <div class="instance-qr-share flex flex-col items-center gap-4">
    <div
      class="instance-qr-image grid aspect-square w-[min(100%,280px)] place-items-center overflow-hidden rounded-md bg-white text-neutral-950"
      :aria-busy="!image && !failed"
    >
      <img
        v-if="image"
        class="block size-full object-contain [image-rendering:pixelated]"
        :src="image"
        :alt="t('account.shareQr')"
        draggable="false"
      />
      <div
        v-else-if="failed"
        class="flex flex-col items-center gap-3 p-5 text-center text-sm"
        role="alert"
      >
        <span>{{ t('account.qrFailed') }}</span
        ><UButton color="neutral" variant="outline" @click="retry++">{{
          t('common.retry')
        }}</UButton>
      </div>
      <span v-else class="p-5 text-sm" role="status">{{ t('common.loading') }}</span>
    </div>
    <div class="flex w-full min-w-0 flex-col items-center gap-1 text-center text-sm">
      <strong class="max-w-full [overflow-wrap:anywhere]">{{ name }}</strong>
      <span class="max-w-full text-muted [overflow-wrap:anywhere]">{{ username }}</span>
      <div class="mt-2 flex w-full items-center gap-1.5 text-left text-muted">
        <span class="min-w-0 flex-1 [overflow-wrap:anywhere]">{{ base }}</span
        ><UButton
          type="button"
          icon="i-lucide-copy"
          color="neutral"
          variant="ghost"
          square
          class="shrink-0"
          :aria-label="t('account.copyLink')"
          :title="t('account.copyLink')"
          @click="copy"
        />
      </div>
    </div>
  </div>
</template>
