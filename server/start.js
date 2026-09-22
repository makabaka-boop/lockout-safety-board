import { buildApp } from './app.js'
import { runMigrations } from './db.js'

const PORT = Number(process.env.PORT || 8080)
const HOST = process.env.HOST || '0.0.0.0'
// 实例标识，仅用于日志：两个 API 实例共享同一裁决（数据库）
const INSTANCE = process.env.INSTANCE_ID || process.env.HOSTNAME || 'api'

async function main() {
  // 每次启动都跑幂等迁移（咨询锁串行化），使任意实例先起来都不影响另一个
  if (process.env.RUN_MIGRATE !== 'false') {
    await runMigrations()
  }
  const app = await buildApp()
  await app.listen({ port: PORT, host: HOST })
  app.log.info(`隔离牌板 API 实例 ${INSTANCE} 监听 http://${HOST}:${PORT}`)
}

main().catch((err) => {
  console.error('[start] 启动失败：', err)
  process.exit(1)
})
