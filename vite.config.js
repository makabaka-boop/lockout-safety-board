import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// 开发态：Vite 把 /api 代理到 Fastify；生产态由 nginx 完成同一件事。
export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT || 5173),
    proxy: {
      '/api': process.env.VITE_API_TARGET || 'http://localhost:8080'
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: true
  },
  test: {
    // 竞争测试与界面测试共用一套真实数据库；界面测试需要 jsdom，
    // API 测试在 jsdom 环境中访问真实 HTTP 服务不受影响。
    environment: 'jsdom',
    globalSetup: './test/globalSetup.js',
    testTimeout: 30000,
    hookTimeout: 90000,
    // 单 fork 串行：竞争条件由测试自行用并发请求制造，文件间共享两个 API 实例。
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true }
    }
  }
})
