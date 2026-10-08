import { defineConfig, type Plugin } from 'vite'

import { loadConfig } from './src/config/loader.ts'

/**
 * T2 验收：配置写错时必须「启动就报错」，而不是等上线才发现。
 * 该插件在 dev server 启动 / 每次重启（含修改 config/*.json 触发重启）时校验配置，
 * 校验失败直接抛错，终端会打印出「是哪个区域 / 哪款盲盒」出了问题。
 */
function configGuardPlugin(): Plugin {
  return {
    name: 'pick-and-luck:config-guard',
    buildStart() {
      const config = loadConfig()
      console.info(
        `[config] 校验通过 — ${config.zones.zones.length} 个区域 / ` +
          `${config.items.items.length} 件垃圾 / ` +
          `${config.gacha.boxes.length} 款盲盒 / ` +
          `${config.vehicles.vehicles.length} 级载具`,
      )
    },
  }
}

export default defineConfig({
  plugins: [configGuardPlugin()],
  build: {
    target: 'es2022',
  },
})
