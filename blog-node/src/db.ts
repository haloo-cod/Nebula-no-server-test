/** PostgreSQL 连接池；Serverless 实例会复用模块级连接池。 */
import pg, { type Pool, type QueryResult, type QueryResultRow } from 'pg'
import { config } from './config.js'

const { Pool: PgPool } = pg

let pool: Pool | undefined

/** 获取可复用的 PostgreSQL 连接池。 */
export function getPool(): Pool {
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL 未配置，Node API 需要托管 PostgreSQL')
  }
  pool ??= new PgPool({
    connectionString: config.databaseUrl,
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    ssl: /localhost|127\.0\.0\.1/.test(config.databaseUrl) ? undefined : { rejectUnauthorized: false },
  })
  return pool
}

/** 执行参数化 SQL 查询。 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, values)
}
