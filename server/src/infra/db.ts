import postgres from 'postgres'
export type Sql = postgres.Sql<{}>
export function makeDb(url: string): Sql {
  return postgres(url, { onnotice: () => {}, max: 10 })
}
