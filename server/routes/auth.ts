// Session, sign-in and the account.
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { verifyPassword, bearerToken } from '../auth.ts'
import { accountUsername, accountPassword } from '../account.ts'
import { buildInfo } from '../build-info.ts'
import type { RouteContext } from './context.ts'

export function authRoutes({ app, store, account, options }: RouteContext) {
  // Ten wrong passwords within a minute of the first stop sign-in and account changes until it ends.
  let attempts: { count: number; until: number } | undefined
  const blocked = (now: number) => !!attempts && attempts.until > now && attempts.count >= 10
  const failed = (now: number) => {
    const current = attempts && attempts.until > now ? attempts : undefined
    attempts = { count: (current?.count ?? 0) + 1, until: current?.until ?? now + 60_000 }
  }
  app.get('/api/session', (c) =>
    c.json({
      authenticated: store.hasSession(bearerToken(c.req.header('authorization'))),
      username: account.username,
      server: buildInfo,
    }),
  )
  app.post('/api/login', async (c) => {
    const input = z
      .object({ username: z.string().max(200), password: z.string().max(1024) })
      .parse(await c.req.json())
    const now = Date.now()
    if (blocked(now)) return c.json({ error: 'Too many attempts. Try again in a minute.' }, 429)
    if (
      input.username !== account.username ||
      !verifyPassword(input.password, account.passwordHash)
    ) {
      failed(now)
      return c.json({ error: 'Incorrect username or password' }, 401)
    }
    attempts = undefined
    const old = bearerToken(c.req.header('authorization'))
    if (old) store.removeSession(old)
    const token = randomBytes(32).toString('base64url')
    store.addSession(token)
    return c.json({
      authenticated: true,
      username: account.username,
      token,
      expiresAt: Date.now() + 7 * 86400_000,
      server: buildInfo,
    })
  })
  app.post('/api/logout', async (c) => {
    store.removeSession(bearerToken(c.req.header('authorization')))
    return c.json({ ok: true })
  })
  app.patch('/api/account', async (c) => {
    if (!options.updateAccount) return c.json({ error: 'Account settings unavailable' }, 503)
    const input = z
      .object({
        username: accountUsername,
        currentPassword: z.string().min(1).max(1024),
        password: accountPassword.optional(),
      })
      .strict()
      .parse(await c.req.json())
    const now = Date.now()
    if (blocked(now)) return c.json({ error: 'Too many attempts. Try again in a minute.' }, 429)
    if (!verifyPassword(input.currentPassword, account.passwordHash)) {
      failed(now)
      return c.json({ error: 'Current password is incorrect', code: 'incorrect-password' }, 403)
    }
    options.updateAccount(input.username, input.password)
    attempts = undefined
    if (input.password !== undefined)
      store.removeOtherSessions(bearerToken(c.req.header('authorization')))
    store.emit('account', account.username)
    return c.json({ username: account.username })
  })
}
