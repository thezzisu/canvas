// Native windows: their content, panes, composer, spaces and creation.
import { z } from 'zod'
import { bearerToken } from '../auth.ts'
import { receiveFile } from '../canvas-files.ts'
import { sourceConnectionKey, nodeLayoutSchema, composerKey, type Source } from '../state.ts'
import * as runtimes from '../runtimes.ts'
import { parseWriteMark } from '../write-order.ts'
import type { RouteContext } from './context.ts'
import {
  nameSchema,
  createWindowSchema,
  createSpaceSchema,
  paneContextSchema,
  paneActionSchema,
  composerSchema,
} from './schemas.ts'

export function windowRoutes({ app, store, terminals, options, order, source }: RouteContext) {
  const composerTarget = (c: { req: { param(name: string): string } }) => ({
    sourceId: c.req.param('id'),
    windowId: c.req.param('window'),
  })
  app.patch('/api/sources/:id/windows/:window/composer', async (c) => {
    const target = composerTarget(c),
      mark = parseWriteMark(c.req.header('canvas-write')),
      resource = `composer/${composerKey(target)}`
    if (!store.acceptsWindow(target)) return c.json({ error: 'Window not found' }, 404)
    const { content } = composerSchema.parse(await c.req.json())
    if (!order.fresh(mark, resource, ['content']).length)
      return c.json(store.currentComposer(target))
    const view = store.updateComposer(target, content)
    order.record(mark, resource, ['content'])
    return c.json(view)
  })
  app.post('/api/sources/:id/windows/:window/composer/files', async (c) => {
    const target = composerTarget(c)
    if (!store.acceptsWindow(target) || !options.assets)
      return c.json({ error: 'Window not found' }, 404)
    const input = z
      .object({
        filename: z.string().min(1).max(255),
        size: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      })
      .strict()
      .parse(c.req.query())
    return c.json(
      await receiveFile(
        store,
        options.assets,
        input,
        { composer: target },
        () => store.acceptsWindow(target),
        c.req.raw,
        bearerToken(c.req.header('authorization')),
      ),
      201,
    )
  })
  app.post('/api/sources/:id/windows/:window/composer/file-references', async (c) => {
    const input = z
      .object({ assetIds: z.array(z.string().uuid()).min(1).max(64) })
      .strict()
      .parse(await c.req.json())
    const assets = store.referenceComposerFiles(composerTarget(c), input.assetIds)
    return assets ? c.json(assets) : c.json({ error: 'Window or file not found' }, 404)
  })
  app.get('/api/sources/:id/spaces/:space/windows/:window/text', async (c) => {
    const source = store.get<Source>('source', c.req.param('id'))
    if (!source || !options.windowContent) return c.json({ error: 'Window not found' }, 404)
    const panes = await options.windowContent.read(
      source,
      c.req.param('space'),
      c.req.param('window'),
      bearerToken(c.req.header('authorization')),
    )
    if (panes.some((pane) => pane.incomplete))
      return c.json({ error: 'Some window content could not be read' }, 503)
    return c.json({
      text: panes
        .map((pane) => pane.lines.join('\n').trimEnd())
        .filter(Boolean)
        .join('\n\n'),
    })
  })
  app.post('/api/sources/:id/spaces/:space/windows/:window/pane-context', async (c) => {
    const point = z
      .object({
        column: z.number().int().min(0).max(4095),
        row: z.number().int().min(0).max(4095),
        cols: z.number().int().min(1).max(4096),
        rows: z.number().int().min(1).max(4096),
        layout: z.string().uuid(),
      })
      .strict()
      .parse(await c.req.json())
    const connection = source(c.req.param('id')),
      key = sourceConnectionKey(connection)
    const target = await terminals.paneContext(
      connection,
      c.req.param('space'),
      c.req.param('window'),
      point,
    )
    if (!store.hasSession(bearerToken(c.req.header('authorization'))))
      return c.json({ error: 'Please sign in' }, 401)
    if (sourceConnectionKey(source(connection.id)) !== key)
      return c.json({ error: 'Connection changed' }, 409)
    return c.json({ pane: target || null })
  })
  app.post('/api/sources/:id/spaces/:space/windows/:window/pane-action', async (c) => {
    const { pane, command } = z
      .object({ pane: paneContextSchema, command: paneActionSchema })
      .strict()
      .parse(await c.req.json())
    const connection = source(c.req.param('id')),
      key = sourceConnectionKey(connection),
      session = bearerToken(c.req.header('authorization'))
    const authorized = () => {
      const current = store.get<Source>('source', connection.id)
      return store.hasSession(session) && !!current && sourceConnectionKey(current) === key
    }
    const windowId = c.req.param('window')
    await terminals.paneAction(
      connection,
      c.req.param('space'),
      windowId,
      { ...pane, name: '' },
      command,
      authorized,
    )
    if (command.action === 'close') {
      const after = await runtimes.listResources(connection)
      if (
        after.status === 'online' &&
        !after.spaces.some((space) => space.windows.some((window) => window.id === windowId))
      )
        store.removeWindowReferences(connection, [windowId])
    }
    return c.json({ ok: true })
  })
  app.post('/api/sources/:id/spaces/:space/windows/:window/scan', async (c) => {
    z.object({})
      .strict()
      .parse(await c.req.json())
    const source = store.get<Source>('source', c.req.param('id'))
    if (!source || !options.windowContent) return c.json({ error: 'Window not found' }, 404)
    return c.json(
      await options.windowContent.scan(
        source,
        c.req.param('space'),
        c.req.param('window'),
        bearerToken(c.req.header('authorization')),
        c.req.raw.signal,
      ),
    )
  })
  app.post('/api/content-scans/:scan/items/:item/open', async (c) => {
    const context = z
      .object({
        canvasId: z.union([z.string().uuid(), z.literal('overview')]).optional(),
        anchorId: z.string().max(150).optional(),
        position: nodeLayoutSchema.pick({ x: true, y: true }).optional(),
      })
      .strict()
      .refine(
        (value) =>
          !value.position || (!!value.canvasId && value.canvasId !== 'overview' && !value.anchorId),
      )
      .parse(await c.req.json())
    const opened = await options.windowContent?.open(
      c.req.param('scan'),
      c.req.param('item'),
      bearerToken(c.req.header('authorization')),
      context,
      c.req.raw.signal,
    )
    return opened ? c.json(opened) : c.json({ error: 'Scan expired; scan this window again' }, 404)
  })
  app.post('/api/sources/:id/spaces', async (c) => {
    const { name, sourceSpaceId } = createSpaceSchema.parse(await c.req.json())
    return c.json(await runtimes.createSpace(source(c.req.param('id')), name, sourceSpaceId), 201)
  })
  app.patch('/api/sources/:id/spaces/:space', async (c) => {
    const { name } = nameSchema.parse(await c.req.json())
    await runtimes.renameSpace(source(c.req.param('id')), c.req.param('space'), name)
    return c.json({ ok: true })
  })
  app.delete('/api/sources/:id/spaces/:space', async (c) => {
    const connection = source(c.req.param('id'))
    const windows = await runtimes.closeSpace(connection, c.req.param('space'))
    store.removeWindowReferences(connection, windows)
    return c.json({ ok: true })
  })
  app.post('/api/sources/:id/spaces/:space/windows', async (c) => {
    const { name } = createWindowSchema.parse(await c.req.json())
    return c.json(
      await runtimes.createWindow(source(c.req.param('id')), c.req.param('space'), name),
      201,
    )
  })
  app.patch('/api/sources/:id/spaces/:space/windows/:window', async (c) => {
    const { name } = nameSchema.parse(await c.req.json())
    await runtimes.renameWindow(
      source(c.req.param('id')),
      c.req.param('space'),
      c.req.param('window'),
      name,
    )
    return c.json({ ok: true })
  })
  app.delete('/api/sources/:id/spaces/:space/windows/:window', async (c) => {
    const connection = source(c.req.param('id')),
      windowId = c.req.param('window')
    await runtimes.closeWindow(connection, c.req.param('space'), windowId)
    store.removeWindowReferences(connection, [windowId])
    return c.json({ ok: true })
  })
}
