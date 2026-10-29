import { z } from 'zod'
import type { GlobalSettings } from '../shared/settings.ts'
import { settingsPatchSchema } from './settings.ts'

// Read compatibility for documents written before every font file was exposed
// as an independent family. This format is never accepted by the settings API.
const legacySchema = z.object({
  contentFont: z.object({
    ligatures: z.boolean(),
    stack: z.array(z.object({
      family: z.string().trim().min(1).max(100).regex(/^[\p{L}\p{N} _+.\-]+$/u),
      variant: z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/).optional(),
    }).strict()).min(1).max(12),
  }).strict(),
}).strict()

export function readLegacySettings(value: unknown): GlobalSettings | undefined {
  const parsed = legacySchema.safeParse(value)
  if (!parsed.success) return
  const seen = new Set<string>()
  const stack = parsed.data.contentFont.stack.filter(font => {
    // The old writer deduplicated by family before resolving its variant.
    const family = font.family.toLowerCase()
    if (seen.has(family)) return false
    seen.add(family)
    return true
  }).map(font => ({
    family: font.family.toLowerCase() === 'maple mono nf cn' && font.variant === 'normal'
      ? 'Maple Mono Normal NF CN' : font.family,
  }))
  // Unknown legacy variants previously resolved to the family's default face.
  // The canonical parser also removes aliases that now name the same font.
  const converted = settingsPatchSchema.safeParse({
    contentFont: { stack, ligatures: parsed.data.contentFont.ligatures },
  })
  return converted.success ? converted.data : undefined
}
