// Workbox serializes these into the generated service worker; keep each self-contained.
type Route = { request: Pick<Request, 'destination'>; url: URL; sameOrigin: boolean }

/** Canvas uses fragment navigation. API and forwarded documents never get a shell fallback. */
export const shellNavigation = /^\/(?:index\.html)?(?:\?.*)?$/
/** Runtime caches hold only requested, versioned public resources: no private files or API responses. */
export const cachedFont = ({ request, url, sameOrigin }: Route) =>
  sameOrigin &&
  request.destination === 'font' &&
  /^\/assets\/[^/]+-[\w-]{8,}\.woff2$/.test(url.pathname)
export const cachedCodePreview = ({ request, url, sameOrigin }: Route) =>
  sameOrigin &&
  ['script', 'worker'].includes(request.destination) &&
  /^\/assets\/code-preview\/[^/]+-[\w-]{8,}\.js$/.test(url.pathname)
