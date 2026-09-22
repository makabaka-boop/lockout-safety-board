import pg from 'pg'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const { Client } = pg
const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const connectionString =
  process.env.DATABASE_URL ||
  'postgres://loto:loto@localhost:5432/loto_board'

// 等待数据库可达（compose 里数据库可能刚启动）
export async function waitForDatabase(attempts = 30, delayMs = 1000) {
  let lastError
  for (let i = 0; i < attempts; i++) {
    const client = new Client({ connectionString })
    try {
      await client.connect()
      await client.query('SELECT 1')
      await client.end()
      return
    } catch (err) {
      lastError = err
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    } finally {
      await client.end().catch(() => {})
    }
  }
  throw lastError
}

// 执行全部迁移。咨询锁 + 事务保证两个 API 实例并发启动时
// 迁移只真正执行一次，另一个实例拿到锁后看到全部对象已存在（脚本本身幂等）。
export async function runMigrations() {
  await waitForDatabase()
  const dir = path.join(__dirname, 'migrations')
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()

  const client = new Client({ connectionString })
  await client.connect()
  try {
    await client.query('SELECT pg_advisory_lock($1)', [9471352])
    for (const file of files) {
      const sql = await readFile(path.join(dir, file), 'utf8')
      await client.query(sql)
      console.log(`[migrate] ${file} 已执行`)
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [9471352]).catch(() => {})
    await client.end()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[migrate] 失败：', err)
      process.exit(1)
    })
}
