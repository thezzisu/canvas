import { resolveApiUrl } from './instance-url'

export interface CanvasFileReference { instance: string; base: string; assetId: string }
export interface FileSourceAccess { base: string; token: string }
export const CANVAS_FILE_TYPE = 'application/x-canvas-file'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

export function parseFileReference(value: string): CanvasFileReference | undefined {
  if (value.length > 4096) return
  try {
    const data = JSON.parse(value)
    if (typeof data?.instance === 'string' && uuid.test(data.instance) && typeof data.base === 'string' && data.base.length <= 2048 && typeof data.assetId === 'string' && uuid.test(data.assetId))
      return { instance: data.instance, base: data.base, assetId: data.assetId }
  } catch { /* Not a Canvas file reference. */ }
}
export function isFileReference(data: DataTransfer | null): data is DataTransfer {
  return !!data && data.types.includes(CANVAS_FILE_TYPE) && !data.types.includes('Files')
}
export function writeFileReference(data: DataTransfer | null, reference: CanvasFileReference): boolean {
  if (!data) return false
  data.effectAllowed = 'copy'
  data.setData(CANVAS_FILE_TYPE, JSON.stringify(reference))
  return true
}
export function readFileReference(data: DataTransfer | null) { return isFileReference(data) ? parseFileReference(data.getData(CANVAS_FILE_TYPE)) : undefined }

/** An explicit transfer reads only the saved source account, never the active target's URL. */
export async function readReferencedFile(reference: CanvasFileReference, access: (instance: string) => FileSourceAccess | undefined, signal: AbortSignal, request: typeof fetch = fetch): Promise<File> {
  const source = access(reference.instance)
  if (!source) throw new Error('fileTransfer.sourceMissing')
  if (source.base !== reference.base) throw new Error('fileTransfer.sourceChanged')
  if (!source.token) throw new Error('fileTransfer.loginRequired')
  const assertCurrent = () => {
    signal.throwIfAborted()
    const current = access(reference.instance)
    if (!current || current.base !== source.base || current.token !== source.token) throw new Error('fileTransfer.sourceChanged')
  }
  assertCurrent()
  const url = resolveApiUrl(source.base, `/api/files/${encodeURIComponent(reference.assetId)}`)
  const response = await request(url, { headers: { Authorization: `Bearer ${source.token}` }, credentials: 'omit', redirect: 'error', signal })
  assertCurrent()
  if (response.status === 401 || response.status === 403) throw new Error('fileTransfer.loginRequired')
  if (response.status === 404) throw new Error('fileTransfer.fileMissing')
  if (!response.ok) throw new Error('fileTransfer.failed')
  const blob = await response.blob()
  assertCurrent()
  const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(response.headers.get('Content-Disposition') || '')?.[1]
  let filename = 'file'
  try { if (encoded) filename = decodeURIComponent(encoded) } catch { /* Keep a safe generic filename when a proxy removes valid metadata. */ }
  return new File([blob], filename, { type: blob.type })
}
