<script setup lang="ts">
// The few glyphs Lucide has no icon for; every other icon is a stock `i-lucide-*` name.
const paths = {
  canvas: 'M4 5h16v14H4z M4 10h16 M10 10v9',
  'keyboard-switch':
    'M2 4h20v11H2z M6 8h.01 M10 8h.01 M14 8h.01 M18 8h.01 M7 12h10 M4 19h16 M17 16l3 3-3 3 M7 16l-3 3 3 3',
  // Lucide-derived (ISC): the mouse-left outline with its wheel marked instead.
  'mouse-middle':
    'M5 9v6a7 7 0 0 0 14 0V9a7 7 0 0 0-4-6.326 M9 2.674A7 7 0 0 0 5 9 M12 7v3 M14 4a2 2 0 1 1-4 0 2 2 0 0 1 4 0',
}
defineProps<{ name: keyof typeof paths; size: number }>()
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.65"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="paths[name]" />
  </svg>
</template>
