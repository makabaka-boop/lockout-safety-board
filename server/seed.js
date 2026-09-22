import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { connectionString, waitForDatabase } from './db.js'
import { hashPassword } from './password.js'

const { Client } = pg

// 演示账号（README 同步说明）。id 固定，便于测试与排障。
const ACCOUNTS = [
  { id: 'a0000000-0000-0000-0000-000000000001', username: 'coordinator', displayName: '王协调', role: 'COORDINATOR', password: 'coord-123' },
  { id: 'a0000000-0000-0000-0000-000000000101', username: 'worker1', displayName: '李检修', role: 'WORKER', password: 'worker-123' },
  { id: 'a0000000-0000-0000-0000-000000000102', username: 'worker2', displayName: '赵检修', role: 'WORKER', password: 'worker-123' },
  { id: 'a0000000-0000-0000-0000-000000000103', username: 'worker3', displayName: '孙检修', role: 'WORKER', password: 'worker-123' },
  { id: 'a0000000-0000-0000-0000-000000000201', username: 'lead', displayName: '钱送电', role: 'ENERGIZE_LEAD', password: 'lead-123' }
]

export async function seed() {
  await waitForDatabase()
  const client = new Client({ connectionString })
  await client.connect()
  try {
    await client.query('BEGIN')
    for (const acc of ACCOUNTS) {
      await client.query(
        'INSERT INTO users (id, username, display_name, role) VALUES ($1, $2, $3, $4) ON CONFLICT (username) DO NOTHING',
        [acc.id, acc.username, acc.displayName, acc.role]
      )
      const { salt, hash } = (() => {
        const stored = hashPassword(acc.password)
        const [s, h] = stored.split(':')
        return { salt: s, hash: h }
      })()
      await client.query(
        `INSERT INTO auth_secrets (user_id, salt, hash)
         SELECT u.id, $2, $3 FROM users u WHERE u.username = $1
         ON CONFLICT (user_id) DO NOTHING`,
        [acc.username, salt, hash]
      )
    }
    await client.query('COMMIT')
    console.log(`[seed] 已写入 ${ACCOUNTS.length} 个演示账号`)
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    await client.end()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[seed] 失败：', err)
      process.exit(1)
    })
}
