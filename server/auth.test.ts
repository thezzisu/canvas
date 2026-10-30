import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bearerToken, allowedOrigin, parseAllowedOrigins } from './auth.ts'

test('bearer sessions and allowed origins have exact syntax and boundaries', () => {
  assert.equal(bearerToken('Bearer test_session-1'), 'test_session-1')
  for (const value of [undefined, 'test', 'Bearer ', 'Bearer token extra', 'Bearer token\n', 'Basic token'])
    assert.equal(bearerToken(value), '')
  const origins = parseAllowedOrigins('https://c.zzs1.cn, http://localhost:3010,https://c.zzs1.cn')
  assert.equal(origins.size, 2)
  for (const origin of ['https://c.zzs1.cn', 'http://localhost:3010', 'http://local.test'])
    assert(allowedOrigin(origin, 'http://local.test', origins))
  for (const origin of ['null', 'https://c.zzs1.cn.evil.test', 'https://c.zzs1.cn/', 'https://c.zzs1.cn:123', 'http://localhost:3011'])
    assert.equal(allowedOrigin(origin, 'http://local.test', origins), false)
  for (const value of ['null', 'file:///tmp', 'https://user@c.zzs1.cn', 'https://c.zzs1.cn/', 'https://c.zzs1.cn/path'])
    assert.throws(() => parseAllowedOrigins(value))
})
