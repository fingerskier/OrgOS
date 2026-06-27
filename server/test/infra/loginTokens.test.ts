import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { freshSchema } from '../helpers/testDb.js'
import { makeLoginTokens } from '../../src/infra/loginTokens.js'
import { ConsoleMailer } from '../../src/infra/mailer.js'
import type { Sql } from '../../src/infra/db.js'

let sql: Sql, drop: () => Promise<void>
beforeAll(async () => { ({ sql, drop } = await freshSchema()) })
afterAll(async () => { await drop() })

describe('loginTokens', () => {
  it('issues then consumes a token exactly once', async () => {
    const lt = makeLoginTokens(sql, 900)
    const token = await lt.issue('m@x.io')
    expect(token.length).toBeGreaterThan(20)
    expect(await lt.consume(token)).toBe('m@x.io')
    expect(await lt.consume(token)).toBeNull()   // single-use
  })
  it('rejects an expired token', async () => {
    const lt = makeLoginTokens(sql, -1)            // already expired
    const token = await lt.issue('e@x.io')
    expect(await lt.consume(token)).toBeNull()
  })
  it('rejects an unknown token', async () => {
    const lt = makeLoginTokens(sql, 900)
    expect(await lt.consume('garbage')).toBeNull()
  })
})

describe('ConsoleMailer', () => {
  it('captures the link', async () => {
    const m = new ConsoleMailer()
    await m.sendMagicLink('m@x.io', 'http://x/auth/callback?token=abc')
    expect(m.last).toEqual({ to: 'm@x.io', link: 'http://x/auth/callback?token=abc' })
  })
})
