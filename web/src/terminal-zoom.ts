import { contentZoomLimits, normalizeContentZoom, useContentZoom } from './content-zoom'

export const terminalZoomLimits = contentZoomLimits
export const normalizeTerminalZoom = normalizeContentZoom
const prefix = 'canvas:terminal-zoom:'
export const terminalZoomStorageKey = (key: string) => prefix + key
export function useTerminalZoom(key: () => string, storage?: Storage) {
  return useContentZoom(() => terminalZoomStorageKey(key()), storage)
}
