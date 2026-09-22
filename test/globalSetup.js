// Vitest 全局准备：
//  - DATABASE_URL 已指向现成 PostgreSQL（compose verify 服务）→ 只跑迁移+种子
//  - 否则（本地 npm test）→ 下载并启动一个真实的嵌入式 PostgreSQL
// 两个 API 实例由 test/servers.js 在首个测试文件里懒启动。
import net from 'node:net'
import { runMigrations } from '../server/db.js'
import { seed } from '../server/seed.js'

function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.connect(port, host)
    socket.once('connect', () => {
      socket.end()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

export default async function setup() {
  let embedded = null

  if (!process.env.DATABASE_URL && !(await portOpen(5432))) {
    const { default: EmbeddedPostgres } = await import('embedded-postgres')
    embedded = new EmbeddedPostgres({
      version: '16.4.0',
      databaseDir: './.embedded-postgres/data',
      user: 'loto',
      password: 'loto',
      port: 5432,
      persistent: false,
      // 精简 Linux 镜像可能只有 C locale；库内部固定追加 en_US.UTF-8，
      // initdb 对重复参数取后者，这里压成 C 使初始化可移植。
      initdbFlags: ['--lc-messages=C']
    })
    await embedded.initialise()
    await embedded.start()
    await embedded.createDatabase('loto_board')
    process.env.DATABASE_URL = 'postgres://loto:loto@127.0.0.1:5432/loto_board'
    console.log('[test] 嵌入式 PostgreSQL 已启动')
  } else if (!process.env.DATABASE_URL) {
    // 5432 已有库在跑：测试需要凭据匹配，无密码本地信任时可直连
    process.env.DATABASE_URL = 'postgres://loto:loto@127.0.0.1:5432/loto_board'
  }

  await runMigrations()
  await seed()

  return async () => {
    if (embedded) await embedded.stop().catch(() => {})
  }
}
