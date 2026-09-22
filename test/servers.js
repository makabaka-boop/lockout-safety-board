// 两个 API 实例共享同一 PostgreSQL 裁决。单 fork 下模块缓存保证全测试只启动一次，
// 竞争测试把请求分别打到 8081/8082 两个实例。
import { buildApp } from '../server/app.js'

let instancesPromise = null

export function getInstances() {
  if (!instancesPromise) {
    instancesPromise = (async () => {
      const appA = await buildApp()
      const appB = await buildApp()
      await appA.listen({ port: 0, host: '127.0.0.1' })
      await appB.listen({ port: 0, host: '127.0.0.1' })
      const portA = appA.server.address().port
      const portB = appB.server.address().port
      return {
        a: { app: appA, url: `http://127.0.0.1:${portA}`, id: 'A' },
        b: { app: appB, url: `http://127.0.0.1:${portB}`, id: 'B' }
      }
    })()
  }
  return instancesPromise
}
