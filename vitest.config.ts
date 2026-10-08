import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // core / config 是纯逻辑，单测一律跑在 node 环境，不依赖浏览器
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    reporters: ['default'],
  },
})
