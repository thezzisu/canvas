import type { WindowContentOpen, WindowContentScan } from '../../shared/window-content'
import { api, apiUrl, requireCurrentApi, segment, type ApiContext } from './api'
import { presentDownload } from './downloads'
import { t } from './i18n'
import { scannedFile } from './terminal-links'

export type ScanFileDestination = { canvasId?: string; anchorId?: string; position?: { x: number; y: number } }

/** Stage one scanned file through the server; only API file and download URLs are accepted. */
export async function openScanFile(scanId: string, itemId: string, destination: ScanFileDestination, context: ApiContext, signal?: AbortSignal) {
  const file = await api<WindowContentOpen>(`/api/content-scans/${segment(scanId)}/items/${segment(itemId)}/open`,
    { method: 'POST', body: JSON.stringify(destination), signal }, context)
  const url = apiUrl(file.url, context)
  if (!/^api\/(?:files|downloads)\/[^/]+$/.test(url.pathname.slice(new URL(context.base).pathname.length)) || url.search) throw new Error(t('panels.scan.openFailed'))
  requireCurrentApi(context)
  return file
}

/** A terminal file link opens only when the window's current scan verifies it as a regular source file. */
export async function previewWindowFile(windowPath: string, path: string, context: ApiContext) {
  const scan = await api<WindowContentScan>(`${windowPath}/scan`, { method: 'POST', body: '{}' }, context)
  const item = scannedFile(scan, path)
  if (!item) throw new Error(t('panels.scan.openFailed'))
  await presentDownload(await openScanFile(scan.id, item.id, {}, context))
}
