import type { VitePWAOptions } from 'vite-plugin-pwa'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { cachedCodePreview, cachedFont, shellNavigation } from './web/src/app/pwa-routes.ts'

const notificationSource = readFileSync(
  new URL('./web/notification-worker.js', import.meta.url),
  'utf8',
)
export const notificationWorker = {
  source: notificationSource,
  fileName: `assets/notification-worker-${createHash('sha256').update(notificationSource).digest('hex').slice(0, 12)}.js`,
}

export const pwaOptions: Partial<VitePWAOptions> = {
  registerType: 'prompt',
  injectRegister: false,
  includeManifestIcons: false,
  manifest: {
    id: './',
    name: 'Canvas',
    short_name: 'Canvas',
    start_url: './',
    scope: './',
    display: 'standalone',
    display_override: ['window-controls-overlay'],
    theme_color: '#17191d',
    background_color: '#17191d',
    icons: [
      { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  },
  workbox: {
    importScripts: [notificationWorker.fileName],
    globPatterns: ['index.html', 'assets/*.{js,css}', 'icons/*.{png,svg}'],
    globIgnores: ['**/fonts/**', '**/*.woff2'],
    maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
    navigateFallback: 'index.html',
    navigateFallbackAllowlist: [shellNavigation],
    cleanupOutdatedCaches: true,
    skipWaiting: false,
    clientsClaim: false,
    runtimeCaching: [
      {
        urlPattern: cachedFont,
        handler: 'CacheFirst',
        options: {
          cacheName: 'canvas-content-fonts',
          cacheableResponse: { statuses: [200] },
          expiration: {
            maxEntries: 20,
            maxAgeSeconds: 365 * 24 * 60 * 60,
            purgeOnQuotaError: true,
          },
        },
      },
      {
        urlPattern: cachedCodePreview,
        handler: 'CacheFirst',
        options: {
          cacheName: 'canvas-code-preview',
          cacheableResponse: { statuses: [200] },
          expiration: {
            maxEntries: 128,
            maxAgeSeconds: 365 * 24 * 60 * 60,
            purgeOnQuotaError: true,
          },
        },
      },
    ],
  },
}
