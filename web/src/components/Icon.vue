<script setup lang="ts">
defineProps<{ name: string; size?: number }>()
const paths: Record<string, string> = {
  canvas: 'M4 5h16v14H4z M4 10h16 M10 10v9',
  grid: 'M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z',
  plus: 'M12 5v14 M5 12h14',
  close: 'M6 6l12 12 M18 6L6 18',
  server: 'M4 4h16v6H4z M4 14h16v6H4z M7 7h.01 M7 17h.01 M11 7h6 M11 17h6',
  terminal: 'M5 7l5 5-5 5 M13 17h6',
  chevron: 'M9 5l7 7-7 7',
  down: 'M6 9l6 6 6-6',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  expand: 'M8 4H4v4 M16 4h4v4 M4 16v4h4 M20 16v4h-4',
  refresh: 'M20 7v5h-5 M4 17v-5h5 M6.1 6.1A8 8 0 0 1 19.4 9 M4.6 15a8 8 0 0 0 13.3 2.9',
  arrow: 'M5 12h14 M13 6l6 6-6 6',
  logout: 'M10 4H4v16h6 M9 12h11 M16 8l4 4-4 4',
  edit: 'M14 5l5 5 M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15z',
  trash: 'M3 6h18 M9 6V3h6v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7',
  search: 'M20 20l-5-5 M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  lock: 'M6 10h12v11H6z M8 10V6a4 4 0 0 1 8 0v4',
  check: 'M5 12l4 4L19 6',
  layers: 'M12 3l10 5-10 5L2 8z M2 12l10 5 10-5 M2 16l10 5 10-5',
  globe: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M3 12h18 M12 3c5 5 5 13 0 18-5-5-5-13 0-18',
  info: 'M12 11v6 M12 7h.01 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  minus: 'M5 12h14',
  copy: 'M8 8h12v12H8z M16 8V4H4v12h4',
  note: 'M4 3h16v13l-5 5H4z M15 21v-5h5 M8 8h8 M8 12h6',
  image: 'M3 3h18v18H3z M3 16l6-6 5 5 3-3 4 4 M16 7h.01',
}
</script>
<template>
  <svg :width="size || 18" :height="size || 18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name] || paths.canvas" /></svg>
</template>
