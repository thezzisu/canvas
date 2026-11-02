import type { Ref } from 'vue'
import type { DropdownMenuItem } from '@nuxt/ui/components/DropdownMenu.vue'
import { t } from './i18n'
import { contentZoomLimits } from './content-zoom'

/** The compact header exposes the same zoom controls inside its native menu. */
export function contentZoomMenu(zoom: Ref<number>, disabled = false): DropdownMenuItem[] {
  return [
    { label: t('common.contentZoom'), type: 'label' },
    { label: t('common.zoomOut'), icon: 'i-lucide-minus', disabled: disabled || zoom.value <= contentZoomLimits.min, onSelect: () => { zoom.value = Math.max(contentZoomLimits.min, zoom.value - contentZoomLimits.step) } },
    { label: t('common.resetZoom'), disabled, onSelect: () => { zoom.value = 100 } },
    { label: t('common.zoomIn'), icon: 'i-lucide-plus', disabled: disabled || zoom.value >= contentZoomLimits.max, onSelect: () => { zoom.value = Math.min(contentZoomLimits.max, zoom.value + contentZoomLimits.step) } },
    { type: 'separator' },
  ]
}
