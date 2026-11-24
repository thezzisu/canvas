// Request bodies the API accepts.
import { z } from 'zod'
import {
  canvasSchema,
  sourceSchema,
  itemSchema,
  nodeLayoutSchema,
  noteNodeSchema,
  noteColorSchema,
} from '../state.ts'
import { layoutFields, type LayoutUpdate } from '../../shared/layout.ts'

export const nameSchema = z.object({ name: z.string().trim().min(1).max(100) }).strict()
/** What a canvas's own settings may change; its cards change through their own routes. */
export const canvasPatchSchema = canvasSchema.pick({ name: true, snapToGrid: true }).partial()
export const sourceProbeSchema = z
  .object(sourceSchema.shape)
  .omit({ id: true, name: true })
  .strict()
export const createWindowSchema = z.object({ name: z.string().trim().max(100).optional() }).strict()
export const createSpaceSchema = createWindowSchema.extend({
  sourceSpaceId: z.string().min(1).max(100).optional(),
})
export const paneContextSchema = z
  .object({ bootId: z.string().min(1).max(4096), paneId: z.string().min(1).max(4096) })
  .strict()
export const paneActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('rename'), name: z.string().trim().max(200) }).strict(),
  z.object({ action: z.enum(['split-right', 'split-down', 'zoom', 'close']) }).strict(),
])
export const opacitySchema = z.number().finite().min(0).max(1)
export const backgroundOpacitySchema = z.object({ opacity: opacitySchema }).strict()
export const nodeListSchema = z.object({ nodes: z.array(itemSchema).max(500) }).strict()
export const layoutSchema = z
  .object({
    nodes: z
      .array(
        nodeLayoutSchema
          .pick({ id: true, x: true, y: true, width: true, height: true })
          .partial()
          .required({ id: true })
          .extend({ expected: nodeLayoutSchema.omit({ id: true }).partial().optional() })
          .refine(
            (value) =>
              !value.expected ||
              (Object.keys(value.expected).length > 0 &&
                ['x', 'y', 'width', 'height'].every(
                  (field) =>
                    (value[field as keyof typeof value] !== undefined) ===
                    (value.expected?.[field as keyof typeof value.expected] !== undefined),
                )),
          ),
      )
      .max(500),
  })
  .strict()
export const noteCreateSchema = noteNodeSchema.omit({ id: true, type: true }).extend({
  x: nodeLayoutSchema.shape.x.default(80),
  y: nodeLayoutSchema.shape.y.default(80),
  width: nodeLayoutSchema.shape.width.default(320),
  height: nodeLayoutSchema.shape.height.default(240),
})
export const notePatchSchema = z
  .object({
    title: z.string().max(200).optional(),
    content: z.string().max(200_000).optional(),
    color: noteColorSchema.optional(),
  })
  .strict()
export const isBackgroundUpload = (method: string, path: string) =>
  method === 'PUT' && /^\/api\/canvases\/[^/]+\/background$/.test(path)
export const isInboxUpload = (method: string, path: string) =>
  method === 'PUT' && /^\/api\/uploads\/[A-Za-z0-9_-]+$/.test(path)
export const isCanvasFileUpload = (method: string, path: string) =>
  method === 'POST' &&
  (/^\/api\/canvases\/[^/]+\/(?:notes\/[^/]+\/)?files$/.test(path) ||
    /^\/api\/sources\/[^/]+\/windows\/[^/]+\/composer\/files$/.test(path))
export const writtenFields = (node: LayoutUpdate) =>
  layoutFields.filter((field) => node[field] !== undefined)
export const pick = <Value extends object, Key extends keyof Value>(
  value: Value,
  keys: readonly Key[],
) => Object.fromEntries(keys.map((key) => [key, value[key]])) as Pick<Value, Key>
export const composerSchema = z.object({ content: z.string().max(200_000) }).strict()
