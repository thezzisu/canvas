import type { VitePWAOptions } from 'vite-plugin-pwa'

// Canvas uses fragment navigation. API and forwarded documents never get a shell fallback.
export const shellNavigation = /^\/(?:index\.html)?(?:\?.*)?$/
export const pwaOptions: Partial<VitePWAOptions> = {
  registerType: 'prompt',
  injectRegister: false,
  includeManifestIcons: false,
  manifest: {
    id: './', name: 'Canvas', short_name: 'Canvas', start_url: './', scope: './',
    display: 'standalone', theme_color: '#17191d', background_color: '#17191d',
    icons: [
      { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  },
  workbox: {
    globPatterns: ['index.html', 'assets/*.{js,css}', 'icons/*.{png,svg}'],
    globIgnores: ['**/fonts/**'],
    maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
    navigateFallback: 'index.html',
    navigateFallbackAllowlist: [shellNavigation],
    cleanupOutdatedCaches: true,
    skipWaiting: false,
    clientsClaim: false,
    runtimeCaching: [],
  },
}
