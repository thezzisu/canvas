self.addEventListener('notificationclick', event => {
  const data = event.notification.data
  if (data?.type !== 'canvas-notification' || typeof data.url !== 'string') return
  let url
  try { url = new URL(data.url); if (url.origin !== self.location.origin) return } catch { return }
  event.notification.close()
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const instance = new URLSearchParams(url.hash.slice(1)).get('instance')
    const client = windows.find(client => {
      const current = new URL(client.url)
      return current.pathname === url.pathname && new URLSearchParams(current.hash.slice(1)).get('instance') === instance
    })
    if (client) {
      await client.focus()
      client.postMessage({ ...data, type: 'canvas:notification-open' })
    } else await self.clients.openWindow(url.href)
  })())
})
