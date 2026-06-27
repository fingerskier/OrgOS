import { randomBytes, createHash } from 'node:crypto'
import type { Sql } from './db.js'

const hash = (t: string): string => createHash('sha256').update(t).digest('hex')

export function makeLoginTokens(sql: Sql, ttlSeconds: number) {
  return {
    async issue(email: string): Promise<string> {
      const token = randomBytes(32).toString('base64url')
      await sql`INSERT INTO login_token (token_hash, email, expires_at)
        VALUES (${hash(token)}, ${email}, now() + (${ttlSeconds} * interval '1 second'))`
      return token
    },
    async consume(token: string): Promise<string | null> {
      const rows = await sql<{ email: string }[]>`
        UPDATE login_token SET used_at = now()
        WHERE token_hash = ${hash(token)} AND used_at IS NULL AND expires_at > now()
        RETURNING email`
      return rows[0]?.email ?? null
    },
  }
}
