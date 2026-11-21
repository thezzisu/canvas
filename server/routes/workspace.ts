// The shared state, settings and navigation order.
import { z } from 'zod'
import { settingsPatchSchema } from '../settings.ts'
import type { RouteContext } from './context.ts'

export function workspaceRoutes({ app, store }: RouteContext) {
  app.get('/api/state', (c) => c.json(store.snapshot()))
  app.get('/api/settings', (c) => c.json(store.settings()))
  app.patch('/api/settings', async (c) =>
    c.json(store.updateSettings(settingsPatchSchema.parse(await c.req.json()))),
  )
  app.patch('/api/navigation-order/:kind', async (c) => {
    const kind = z.enum(['canvases', 'sources']).parse(c.req.param('kind'))
    const { ids } = z
      .object({ ids: z.array(z.string().min(1).max(200)).max(1000) })
      .strict()
      .parse(await c.req.json())
    return c.json(store.updateNavigationOrder(kind, ids))
  })
}
