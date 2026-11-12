/** Only explicit passive resource types are navigated without executing site code. */
export function documentLinkNeedsTrust(value: string, base: string): boolean {
  try {
    const url = new URL(value, base)
    if (
      url.origin !== new URL(base).origin ||
      !/\/api\/capture\/[A-Za-z0-9_-]{43}\//u.test(url.pathname)
    )
      return false
    const path = decodeURIComponent(url.pathname)
    return !/\.(?:md|markdown|mdown|mkdn?|mdx|txt|json|log|csv|pdf|png|jpe?g|webp|gif|avif|bmp|ico|mp3|wav|ogg|mp4|webm)$/iu.test(
      path,
    )
  } catch {
    return true
  }
}
