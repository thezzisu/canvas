// Connections: their resources, web forwarding and settings.
import { z } from 'zod'
import { bearerToken } from '../auth.ts'
import { sourceSchema, sourceConnectionKey, type Source } from '../state.ts'
import * as runtimes from '../runtimes.ts'
import type { RouteContext } from './context.ts'
import { sourceProbeSchema } from './schemas.ts'

export function sourceRoutes({ app, store, terminals, options, source }: RouteContext) {
  app.post('/api/urls', async (c) => {
    const value = z
      .object({ sourceId: z.string().uuid(), url: z.string().max(8192) })
      .strict()
      .parse(await c.req.json())
    const opened = options.openUrl?.(
      source(value.sourceId),
      value.url,
      bearerToken(c.req.header('authorization')),
    )
    return opened ? c.json(opened) : c.json({ error: 'Web forwarding is unavailable' }, 503)
  })
  app.get('/api/resources', async (c) =>
    c.json({
      sources: await Promise.all(
        store.list<Source>('source').map(async (s) => {
          const resource = await runtimes.listResources(s)
          return options.completionReads?.projectResources(s, resource) || resource
        }),
      ),
    }),
  )
  app.post('/api/sources/probe', async (c) =>
    c.json(
      await runtimes.probeSource(sourceProbeSchema.parse(await c.req.json()), c.req.raw.signal),
    ),
  )
  app.post('/api/sources', async (c) => {
    const s = sourceSchema.parse(await c.req.json())
    if (s.id) return c.json({ error: 'ID is assigned by the server' }, 400)
    runtimes.validateSource({ ...s, id: s.id ?? 'new' })
    return c.json(store.put('source', s), 201)
  })
  app.patch('/api/sources/:id', async (c) => {
    const id = c.req.param('id')
    const patch = await c.req.json()
    const previous = source(id)
    const s = sourceSchema.parse({
      ...previous,
      ...patch,
      id,
    })
    runtimes.validateSource({ ...s, id })
    let updated = s
    if (sourceConnectionKey({ ...s, id }) !== sourceConnectionKey(previous)) {
      await terminals.closeSource(id, async () => {
        await options.closeOpenBridge?.(id)
        await runtimes.closeRuntimeConnections(id)
        // A name-only edit may have completed while the old connection closed.
        updated = store.put('source', sourceSchema.parse({ ...source(id), ...patch, id }))
      })
    } else updated = store.put('source', s)
    return c.json(updated)
  })
  app.delete('/api/sources/:id', async (c) => {
    const id = c.req.param('id')
    source(id)
    await terminals.closeSource(id, async () => {
      await options.closeOpenBridge?.(id)
      await runtimes.closeRuntimeConnections(id)
      store.remove('source', id)
    })
    return c.json({ ok: true })
  })
}
