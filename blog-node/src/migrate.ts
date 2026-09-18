/** 一次性 PostgreSQL 迁移命令；不要在 Serverless 请求生命周期中执行。 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { getPool } from './db.js'

const migrationPath = fileURLToPath(new URL('../migrations/001_initial.sql', import.meta.url))
const sql = await readFile(migrationPath, 'utf8')
const pool = getPool()
const client = await pool.connect()
try {
  await client.query('begin')
  await client.query(sql)
  await client.query(
    `insert into schema_migrations (version) values ($1) on conflict (version) do nothing`,
    ['001_initial'],
  )
  await client.query('commit')
  console.log('Applied migration 001_initial')
} catch (error) {
  await client.query('rollback')
  throw error
} finally {
  client.release()
  await pool.end()
}
