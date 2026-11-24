// Canvases, their cards, notes, layout and backgrounds.
import { isSystemCanvas } from '../../shared/system-canvases.ts'
import { LayoutConflict } from '../state.ts'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { bearerToken } from '../auth.ts'
import { canvasSchema, nodeLayoutSchema, isTerminalNode, type Canvas } from '../state.ts'
import { parseWriteMark } from '../write-order.ts'
import { type LayoutField, type LayoutUpdate } from '../../shared/layout.ts'
import {
  DEFAULT_BACKGROUND_OPACITY,
  backgroundContentType,
  validateBackground,
  readBackground,
  storedBackgroundContentType,
} from '../backgrounds.ts'
import type { RouteContext } from './context.ts'
import {
  opacitySchema,
  backgroundOpacitySchema,
  nodeListSchema,
  layoutSchema,
  noteCreateSchema,
  notePatchSchema,
  writtenFields,
  pick,
  canvasPatchSchema,
} from './schemas.ts'

export function canvasRoutes({ app, store, order }: RouteContext) {
  app.post('/api/canvases', async (c) => {
    const value = canvasSchema.parse(await c.req.json())
    if (value.id) return c.json({ error: 'ID is assigned by the server' }, 400)
    return c.json(store.canvasView(store.put('canvas', value)), 201)
  })
  app.patch('/api/canvases/:id', async (c) => {
    const id = c.req.param('id')
    if (isSystemCanvas(id)) return c.json({ error: 'System canvases are read-only' }, 403)
    const patch = canvasPatchSchema.parse(await c.req.json())
    const canvas = store.get<Canvas>('canvas', id)
    if (!canvas) return c.json({ error: 'Canvas not found' }, 404)
    return c.json(store.canvasView(store.put('canvas', { ...canvas, ...patch })))
  })
  app.delete('/api/canvases/:id', (c) => {
    if (isSystemCanvas(c.req.param('id')))
      return c.json({ error: 'System canvases are read-only' }, 403)
    store.remove('canvas', c.req.param('id'))
    return c.json({ ok: true })
  })
  app.post('/api/canvases/:id/nodes', async (c) => {
    const id = c.req.param('id')
    if (isSystemCanvas(id)) return c.json({ error: 'System canvases are read-only' }, 403)
    const { nodes } = nodeListSchema.parse(await c.req.json())
    const canvas = store.get<Canvas>('canvas', id)
    if (!canvas) return c.json({ error: 'Canvas not found' }, 404)
    for (const node of nodes)
      if (
        !canvas.nodes.some(
          (existing) =>
            existing.id === node.id ||
            (isTerminalNode(existing) &&
              isTerminalNode(node) &&
              existing.sourceId === node.sourceId &&
              existing.windowId === node.windowId),
        )
      )
        canvas.nodes.push(node)
    return c.json(store.canvasView(store.put('canvas', canvasSchema.parse(canvas))))
  })
  app.post('/api/canvases/:id/notes', async (c) => {
    const id = c.req.param('id')
    if (isSystemCanvas(id)) return c.json({ error: 'System canvases are read-only' }, 403)
    const value = noteCreateSchema.parse(await c.req.json())
    const canvas = store.get<Canvas>('canvas', id)
    if (!canvas) return c.json({ error: 'Canvas not found' }, 404)
    const note = {
      id: randomUUID(),
      type: 'note' as const,
      ...value,
    }
    canvas.nodes.push(note)
    return c.json(store.canvasView(store.put('canvas', canvasSchema.parse(canvas))), 201)
  })
  app.post('/api/canvases/:id/references', async (c) => {
    const id = c.req.param('id')
    const input = z
      .object({
        sourceCanvasId: z.string(),
        nodeId: nodeLayoutSchema.shape.id,
        x: nodeLayoutSchema.shape.x.default(80),
        y: nodeLayoutSchema.shape.y.default(80),
      })
      .strict()
      .parse(await c.req.json())
    if (isSystemCanvas(id) || isSystemCanvas(input.sourceCanvasId))
      return c.json({ error: 'System canvases are read-only' }, 403)
    const sourceCanvas = store.get<Canvas>('canvas', input.sourceCanvasId)
    if (!sourceCanvas || !store.get<Canvas>('canvas', id))
      return c.json({ error: 'Canvas not found' }, 404)
    const node = sourceCanvas.nodes.find((item) => item.id === input.nodeId)
    if (!node || node.type === 'terminal') return c.json({ error: 'Shareable card not found' }, 404)
    const result = store.addNodeReference(input.sourceCanvasId, input.nodeId, id, {
      x: input.x,
      y: input.y,
    })
    return c.json(store.canvasView(result.canvas), result.added ? 201 : 200)
  })
  app.patch('/api/canvases/:id/notes/:node', async (c) => {
    const id = c.req.param('id'),
      nodeId = c.req.param('node'),
      mark = parseWriteMark(c.req.header('canvas-write')),
      resource = `note/${nodeId}`
    if (isSystemCanvas(id)) return c.json({ error: 'System canvases are read-only' }, 403)
    const patch = notePatchSchema.parse(await c.req.json())
    const canvas = store.get<Canvas>('canvas', id)
    if (!canvas) return c.json({ error: 'Canvas not found' }, 404)
    const node = canvas.nodes.find((item) => item.id === nodeId)
    if (!node || node.type !== 'note') return c.json({ error: 'Note not found' }, 404)
    const fields = Object.keys(patch) as (keyof typeof patch)[],
      fresh = order.fresh(mark, resource, fields)
    if (fields.length && !fresh.length) return c.json(store.canvasView(canvas))
    const updated = store.updateNote(id, nodeId, pick(patch, fresh))
    order.record(mark, resource, fresh)
    return c.json(store.canvasView(updated))
  })
  app.patch('/api/canvases/:id/layout', async (c) => {
    const id = c.req.param('id'),
      mark = parseWriteMark(c.req.header('canvas-write'))
    if (isSystemCanvas(id)) return c.json({ error: 'System canvases are read-only' }, 403)
    const { nodes } = layoutSchema.parse(await c.req.json())
    const cards = store.get<Canvas>('canvas', id)?.nodes ?? []
    // Every canvas showing a window shares its size, so that is ordered per window.
    const resource = (node: LayoutUpdate, field: LayoutField) => {
      const card = cards.find((item) => item.id === node.id)
      return card && isTerminalNode(card) && (field === 'width' || field === 'height')
        ? `window-size/${card.sourceId}/${card.windowId}`
        : `layout/${id}/${node.id}`
    }
    const fresh = nodes.flatMap((node): LayoutUpdate[] => {
      const fields = writtenFields(node).filter(
        (field) => order.fresh(mark, resource(node, field), [field]).length,
      )
      if (!fields.length) return []
      return [
        {
          id: node.id,
          ...pick(node, fields),
          ...(node.expected && { expected: pick(node.expected, fields) }),
        },
      ]
    })
    try {
      const canvas =
        nodes.length && !fresh.length
          ? store.get<Canvas>('canvas', id)
          : store.applyLayout(id, fresh)
      if (!canvas) return c.json({ error: 'Canvas not found' }, 404)
      for (const node of fresh)
        for (const field of writtenFields(node)) order.record(mark, resource(node, field), [field])
      return c.json(store.canvasView(canvas))
    } catch (error) {
      if (error instanceof LayoutConflict)
        return c.json({ error: 'Layout changed on another device', code: 'layout-conflict' }, 409)
      throw error
    }
  })
  app.delete('/api/canvases/:id/nodes/:node', (c) => {
    const id = c.req.param('id')
    if (isSystemCanvas(id)) return c.json({ error: 'System canvases are read-only' }, 403)
    const result = store.removeCard(
      id,
      c.req.param('node'),
      bearerToken(c.req.header('authorization')),
    )
    return result
      ? c.json({ ...result, canvas: store.canvasView(result.canvas) })
      : c.json({ error: 'Canvas not found' }, 404)
  })
  app.post('/api/canvases/:id/removals/:token/undo', async (c) => {
    z.object({})
      .strict()
      .parse(await c.req.json())
    const canvas = store.restoreCard(
      c.req.param('id'),
      c.req.param('token'),
      bearerToken(c.req.header('authorization')),
    )
    return canvas
      ? c.json(store.canvasView(canvas))
      : c.json({ error: 'Undo expired or unavailable' }, 404)
  })
  app.put('/api/canvases/:id/background', async (c) => {
    const id = c.req.param('id')
    if (!store.get<Canvas>('canvas', id)) return c.json({ error: 'Canvas not found' }, 404)
    const rawOpacity = c.req.query('opacity')
    const opacity =
      rawOpacity === undefined
        ? undefined
        : z.string().trim().min(1).transform(Number).pipe(opacitySchema).parse(rawOpacity)
    const image = await readBackground(c.req.raw)
    validateBackground(image, backgroundContentType(c.req.header('content-type')))
    // A canvas can be deleted while the upload is being read.
    const canvas = store.get<Canvas>('canvas', id)
    if (!canvas) return c.json({ error: 'Canvas not found' }, 404)
    store.setCanvasBackground(
      id,
      image,
      opacity ?? store.canvasView(canvas).background?.opacity ?? DEFAULT_BACKGROUND_OPACITY,
    )
    return c.json(store.canvasView(canvas))
  })
  app.patch('/api/canvases/:id/background', async (c) => {
    const id = c.req.param('id')
    const canvas = store.get<Canvas>('canvas', id)
    if (!canvas) return c.json({ error: 'Canvas not found' }, 404)
    const { opacity } = backgroundOpacitySchema.parse(await c.req.json())
    if (!store.canvasView(canvas).background) return c.json({ error: 'Background not found' }, 404)
    store.setCanvasBackgroundOpacity(id, opacity)
    return c.json(store.canvasView(canvas))
  })
  app.delete('/api/canvases/:id/background', (c) => {
    const id = c.req.param('id')
    const canvas = store.get<Canvas>('canvas', id)
    if (!canvas) return c.json({ error: 'Canvas not found' }, 404)
    store.removeCanvasBackground(id)
    return c.json(store.canvasView(canvas))
  })
  app.get('/api/backgrounds/:id', (c) => {
    const image = store.getBackground(c.req.param('id'))
    if (!image) return c.json({ error: 'Background not found' }, 404)
    c.header('Content-Type', storedBackgroundContentType(image))
    c.header('Content-Length', String(image.byteLength))
    c.header('Cross-Origin-Resource-Policy', 'same-origin')
    return c.body(image as Uint8Array<ArrayBuffer>)
  })
}
