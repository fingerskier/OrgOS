export interface Config {
  port: number
  webOrigin: string
  databaseUrl: string
  sessionSecret: string
  magicLinkTtlSeconds: number
  isDev: boolean
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const req = (k: string): string => {
    const v = env[k]
    if (!v) throw new Error(`missing env ${k}`)
    return v
  }
  return {
    port: Number(env.SERVER_PORT ?? 8787),
    webOrigin: env.WEB_ORIGIN ?? 'http://localhost:5173',
    databaseUrl: req('DATABASE_URL'),
    sessionSecret: req('SESSION_SECRET'),
    magicLinkTtlSeconds: Number(env.MAGIC_LINK_TTL_SECONDS ?? 900),
    isDev: (env.NODE_ENV ?? 'development') !== 'production',
  }
}
