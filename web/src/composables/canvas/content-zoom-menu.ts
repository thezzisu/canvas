import type { Ref } from 'vue'
import type { DropdownMenuItem } from '@nuxt/ui/components/DropdownMenu.vue'
import { t } from '../../plugins/i18n'
import { zoomIn, zoomOut } from '../../utils/zoom/zoom-steps'
import { contentZoomLimits } from './content-zoom'

export interface ZoomReset {
  reset?: () => void
  resetLabel?: string
}

/** Standard native menu rows appear only when their shared zoom shortcut overflows. */
export function contentZoomMenu(
  zoom: Ref<number>,
  disabled = false,
  options: ZoomReset = {},
): DropdownMenuItem[] {
  return [
    {
      slot: 'zoom',
      label: t('common.zoomOut'),
      icon: 'i-lucide-minus',
      disabled: disabled || zoomOut(zoom.value, contentZoomLimits) === zoom.value,
      onSelect: () => {
        zoom.value = zoomOut(zoom.value, contentZoomLimits)
      },
    },
    {
      slot: 'zoom',
      label: options.resetLabel || t('common.resetZoom'),
      icon: 'i-lucide-rotate-ccw',
      disabled,
      onSelect: () => {
        if (options.reset) options.reset()
        else zoom.value = 100
      },
    },
    {
      slot: 'zoom',
      label: t('common.zoomIn'),
      icon: 'i-lucide-plus',
      disabled: disabled || zoomIn(zoom.value, contentZoomLimits) === zoom.value,
      onSelect: () => {
        zoom.value = zoomIn(zoom.value, contentZoomLimits)
      },
    },
  ]
}
