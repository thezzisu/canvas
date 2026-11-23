import {
  computed,
  inject,
  onScopeDispose,
  provide,
  ref,
  shallowRef,
  watch,
  type ComputedRef,
  type InjectionKey,
  type Ref,
  type ShallowRef,
} from 'vue'
import { useResizeObserver } from '@vueuse/core'
import { MATERIAL_MARGIN, type WallpaperMaterial } from '../../utils/workspace/wallpaper-material'

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Where the material lies, in the stage's coordinates: over the wallpaper as `object-fit: cover`
 * places it in the stage, and over the margin around it.
 */
export function materialBox(stage: Box, image: { width: number; height: number }): Box {
  const scale =
    image.width && image.height
      ? Math.max(stage.width / image.width, stage.height / image.height)
      : 1
  const width = image.width && image.height ? image.width * scale : stage.width,
    height = image.width && image.height ? image.height * scale : stage.height
  return {
    left: stage.left + (stage.width - width) / 2 - width * MATERIAL_MARGIN,
    top: stage.top + (stage.height - height) / 2 - height * MATERIAL_MARGIN,
    width: width * (1 + 2 * MATERIAL_MARGIN),
    height: height * (1 + 2 * MATERIAL_MARGIN),
  }
}

/** The material's position and size in a cover's own pixels, each `scale` stage pixels wide. */
export function coverBackground(material: Box, cover: Box, scale: number) {
  const px = (value: number) => `${Math.round((value / scale) * 100) / 100}px`
  return {
    position: `${px(material.left - cover.left)} ${px(material.top - cover.top)}`,
    size: `${px(material.width)} ${px(material.height)}`,
  }
}

export interface Mica {
  /** The wallpaper the stage shows, with its opacity. The stage keeps it current. */
  wallpaper: ShallowRef<{ material?: WallpaperMaterial; opacity: number } | undefined>
  /** What the stage and a maximized card's overlay carry, for the covers inside them. */
  style: ComputedRef<Record<string, string>>
  add(cover: HTMLElement): void
  delete(cover: HTMLElement): void
}
const micaKey: InjectionKey<Mica> = Symbol('mica')

/**
 * Mica: a cover shows the wallpaper's material as it lies behind the cover. The wallpaper is fixed
 * to the stage, so when the camera or a card moves, a cover shows another part of it. Only covers
 * on screen are placed: after a change of the camera, a card, the stage or the cover itself, all
 * of them are measured and then written, which costs one layout. A move is placed in the frame it
 * is painted in: VueFlow writes a card's transform after its own store update, which an animation
 * frame follows.
 */
export function useMica(surface: Ref<HTMLElement | undefined>, moved: () => unknown): Mica {
  const wallpaper: Mica['wallpaper'] = shallowRef()
  const covers = new Set<HTMLElement>()
  const count = ref(0)
  function place() {
    const material = wallpaper.value?.material,
      stage = surface.value
    if (!material || !stage || !covers.size) return
    const box = materialBox(stage.getBoundingClientRect(), material)
    const measured = [...covers].map(
      (cover) => [cover, cover.getBoundingClientRect(), cover.offsetWidth] as const,
    )
    for (const [cover, rect, width] of measured) {
      if (!width || !rect.width) continue
      const { position, size } = coverBackground(box, rect, rect.width / width)
      cover.style.setProperty('--mica-position', position)
      cover.style.setProperty('--mica-size', size)
    }
  }
  let frame = 0
  function schedule() {
    if (!frame)
      frame = requestAnimationFrame(() => {
        frame = 0
        place()
      })
  }
  // A size is known after layout, before paint, where placing at once shows no stale frame.
  const observer = new ResizeObserver(place)
  onScopeDispose(() => {
    observer.disconnect()
    cancelAnimationFrame(frame)
  })
  useResizeObserver(surface, place)
  watch(wallpaper, schedule, { flush: 'post' })
  watch(() => count.value && moved(), schedule, { flush: 'post' })
  const mica: Mica = {
    wallpaper,
    style: computed(() => {
      const value = wallpaper.value
      if (!value?.material) return { '--mica-image': 'none' }
      // A faint wallpaper is a faint material: the plain material shows through as much.
      const tint = `color-mix(in srgb, var(--material) ${(1 - value.opacity) * 100}%, transparent)`
      return { '--mica-image': `linear-gradient(${tint}, ${tint}), url("${value.material.url}")` }
    }),
    add(cover) {
      covers.add(cover)
      count.value = covers.size
      observer.observe(cover)
      schedule()
    },
    delete(cover) {
      covers.delete(cover)
      count.value = covers.size
      observer.unobserve(cover)
    },
  }
  provide(micaKey, mica)
  return mica
}

/** Keeps a cover in the material where it lies while `shown`. Outside a canvas it stays plain. */
export function useMicaCover(cover: Ref<HTMLElement | undefined>, shown: () => boolean) {
  const mica = inject(micaKey, undefined)
  if (!mica) return
  watch(
    () => (shown() ? cover.value : undefined),
    (element, _, onCleanup) => {
      if (!element) return
      mica.add(element)
      onCleanup(() => mica.delete(element))
    },
    { immediate: true, flush: 'post' },
  )
}
