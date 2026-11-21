import { Hono } from 'hono'
import type { AppOptions, RouteContext } from './routes/context.ts'
import { authRoutes } from './routes/auth.ts'
import { canvasRoutes } from './routes/canvases.ts'
import { eventRoutes } from './routes/events.ts'
import { fileRoutes } from './routes/files.ts'
import { sourceRoutes } from './routes/sources.ts'
import { windowRoutes } from './routes/windows.ts'
import { workspaceRoutes } from './routes/workspace.ts'
import { isBackgroundUpload, isCanvasFileUpload, isInboxUpload } from './routes/schemas.ts'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { bearerToken, allowedOrigin } from './auth.ts'
import { type Account } from './account.ts'
import { Store, type Source } from './state.ts'
import { WriteOrder } from './write-order.ts'
import type { TerminalManager } from './terminals.ts'
import { BackgroundError, backgroundContentType } from './backgrounds.ts'
export type { Account } from './account.ts'
export function createApp(
  store: Store,
  account: Account,
  terminals: TerminalManager,
  options: AppOptions = {},
) {
  const app = new Hono()
  const order = new WriteOrder()
  const origins = options.allowedOrigins || new Set<string>()
  const source = (id: string) => {
    const result = store.get<Source>('source', id)
    if (!result) throw new Error('Source not found')
    return result
  }
  const context: RouteContext = { app, store, account, terminals, options, order, origins, source }
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    c.header('X-Content-Type-Options', 'nosniff')
    const origin = c.req.header('origin')
    if (origin && !allowedOrigin(origin, new URL(c.req.url).origin, origins))
      return c.json({ error: 'Request origin rejected' }, 403)
    if (origin) {
      c.header('Access-Control-Allow-Origin', origin)
      c.header('Vary', 'Origin')
      c.header(
        'Access-Control-Expose-Headers',
        'Content-Length, Content-Disposition, Content-Range, Accept-Ranges',
      )
    }
    if (c.req.method === 'OPTIONS') {
      c.header('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS')
      c.header('Access-Control-Allow-Headers', 'Authorization, Canvas-Write, Content-Type, Range')
      c.header('Access-Control-Max-Age', '600')
      return c.body(null, 204)
    }
    const ticketRequest =
      ['GET', 'HEAD'].includes(c.req.method) && /^\/api\/media\/[A-Za-z0-9_-]+$/.test(c.req.path)
    if (
      !['/api/login', '/api/session'].includes(c.req.path) &&
      !ticketRequest &&
      !store.hasSession(bearerToken(c.req.header('authorization')))
    )
      return c.json({ error: 'Please sign in' }, 401)
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      if (isBackgroundUpload(c.req.method, c.req.path))
        backgroundContentType(c.req.header('content-type'))
      else if (
        isInboxUpload(c.req.method, c.req.path) ||
        isCanvasFileUpload(c.req.method, c.req.path)
      ) {
        if (c.req.header('content-type') !== 'application/octet-stream')
          return c.json({ error: 'File bytes required' }, 415)
      } else if (!c.req.header('content-type')?.startsWith('application/json'))
        return c.json({ error: 'JSON required' }, 415)
    }
    return next()
  })
  const jsonBodyLimit = bodyLimit({
    maxSize: 1024 * 1024,
    onError: (c) => c.json({ error: 'Request too large' }, 413),
  })
  app.use('/api/*', (c, next) =>
    isBackgroundUpload(c.req.method, c.req.path) ||
    isInboxUpload(c.req.method, c.req.path) ||
    isCanvasFileUpload(c.req.method, c.req.path)
      ? next()
      : jsonBodyLimit(c, next),
  )
  for (const routes of [
    authRoutes,
    fileRoutes,
    windowRoutes,
    workspaceRoutes,
    eventRoutes,
    sourceRoutes,
    canvasRoutes,
  ])
    routes(context)
  app.onError((error, c) => {
    if (error instanceof BackgroundError) return c.json({ error: error.message }, error.status)
    if (error instanceof z.ZodError)
      return c.json(
        {
          error: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        },
        400,
      )
    return c.json({ error: error.message }, 400)
  })
  return app
}
