export const textPreviewLimit = 1024 * 1024

/** Decode a bounded UTF-8 prefix as plain text, and release the remaining body. */
export async function readTextPreview(url: string, size: number, signal: AbortSignal): Promise<{ text: string; truncated: boolean }> {
  const response = await fetch(url, { signal })
  if (response.status === 401) window.dispatchEvent(new Event('canvas:unauthorized'))
  if (!response.ok) throw new Error(response.status === 404 ? '文件已过期或不存在' : `读取失败 (${response.status})`)
  const reader = response.body?.getReader()
  if (!reader) return { text: '', truncated: false }
  const decoder = new TextDecoder('utf-8')
  let bytes = 0, text = '', truncated = false
  try {
    while (bytes < textPreviewLimit) {
      const chunk = await reader.read()
      if (chunk.done) break
      const accepted = chunk.value.subarray(0, textPreviewLimit - bytes)
      text += decoder.decode(accepted, { stream: true })
      bytes += accepted.byteLength
      if (accepted.byteLength < chunk.value.byteLength || bytes === textPreviewLimit && size > textPreviewLimit) {
        truncated = true
        break
      }
    }
    if (!truncated) text += decoder.decode()
    return { text, truncated }
  } finally { await reader.cancel().catch(() => {}) }
}
