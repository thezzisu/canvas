import { z } from 'zod'
import type { ContentFontSettings } from '../shared/settings.ts'

// Each entry is a family name, not an arbitrary CSS declaration or a URL.
const familyName = z.string().trim().min(1).max(100)
  .regex(/^[\p{L}\p{N} _+.\-]+$/u, '请输入单个字体名称')
export const contentFontSchema = z.object({
  ligatures: z.boolean(),
  stack: z.array(z.object({ family: familyName }).strict()).min(1).max(12).transform(fonts => {
    const seen = new Set<string>()
    return fonts.filter(font => {
      const id = font.family.toLowerCase()
      if (seen.has(id)) return false
      seen.add(id); return true
    })
  }),
}).strict() satisfies z.ZodType<ContentFontSettings>
export const settingsPatchSchema = z.object({ contentFont: contentFontSchema }).strict()
