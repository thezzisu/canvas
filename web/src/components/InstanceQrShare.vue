<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import UButton from '@nuxt/ui/components/Button.vue'
import { copyText } from '../clipboard'

const props = defineProps<{ link: string; name: string; base: string; username: string }>()
const { t } = useI18n()
const image = ref(''), failed = ref(false), retry = ref(0)
const copied = ref<'copied' | 'failed'>()

watch([() => props.link, retry], async ([link], _, onCleanup) => {
  let current = true
  onCleanup(() => { current = false })
  image.value = ''; failed.value = false; copied.value = undefined
  try {
    const { toDataURL } = await import('qrcode')
    const data = await toDataURL(link, { errorCorrectionLevel: 'M', margin: 4, scale: 8, color: { dark: '#111111', light: '#ffffff' } })
    if (current) image.value = data
  } catch { if (current) failed.value = true }
}, { immediate: true })

function copy() {
  const link = props.link
  copied.value = 'copied'
  copyText(link, () => { if (props.link === link) copied.value = 'failed' })
}
</script>

<template>
  <div class="instance-qr-share">
    <div class="instance-qr-image" :aria-busy="!image && !failed">
      <img v-if="image" :src="image" :alt="t('account.shareQr')" draggable="false" />
      <div v-else-if="failed" class="instance-qr-status" role="alert"><span>{{ t('account.qrFailed') }}</span><UButton color="neutral" variant="outline" @click="retry++">{{ t('common.retry') }}</UButton></div>
      <span v-else class="instance-qr-status" role="status">{{ t('common.loading') }}</span>
    </div>
    <div class="instance-qr-details">
      <strong>{{ name }}</strong>
      <span>{{ username }}</span>
      <div class="instance-qr-address"><span>{{ base }}</span><UButton type="button" :icon="copied === 'copied' ? 'i-lucide-check' : 'i-lucide-copy'" color="neutral" variant="ghost" :aria-label="t('account.copyLink')" :title="copied ? t(`terminal.clipboard.${copied}`) : t('account.copyLink')" @click="copy" /></div>
      <span class="sr-only" role="status">{{ copied ? t(`terminal.clipboard.${copied}`) : '' }}</span>
    </div>
  </div>
</template>

<style scoped>
.instance-qr-share{display:flex;flex-direction:column;align-items:center;gap:16px}
.instance-qr-image{display:grid;place-items:center;aspect-ratio:1;width:min(100%,280px);background:#fff;color:#15171a;border-radius:8px;overflow:hidden}
.instance-qr-image img{display:block;width:100%;height:100%;object-fit:contain;image-rendering:pixelated}
.instance-qr-status{display:flex;flex-direction:column;align-items:center;gap:12px;padding:20px;font-size:13px;text-align:center}
.instance-qr-details{display:flex;flex-direction:column;align-items:center;gap:4px;width:100%;min-width:0;text-align:center;font-size:13px}
.instance-qr-details>strong,.instance-qr-details>span{max-width:100%;overflow-wrap:anywhere}
.instance-qr-details>span{color:#a3abb8}
.instance-qr-address{display:flex;align-items:center;gap:6px;width:100%;margin-top:8px;color:#a3abb8;font-size:12px;text-align:left}
.instance-qr-address>span{flex:1;min-width:0;overflow-wrap:anywhere}.instance-qr-address>button{flex-shrink:0}
</style>
