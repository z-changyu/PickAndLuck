import './ui/theme.css'

import { ConfigValidationError, loadConfig } from './config/loader'
import { createGameApp, syncCanvasSize } from './render/app'
import { browserStore, loadAnalyticsLog, loadSave, writeSave } from './render/storage'
import { PickupController } from './scenes/pickup/controller'
import { PickupScene } from './scenes/pickup/scene'
import { YardScene } from './scenes/yard/scene'
import { mountGamePanel } from './ui/game-panel'

/**
 * 阶段一入口：配置校验 → 读档 / 建新档 → 起 Pixi → 挂拾取场景 + 侧栏面板。
 *
 * 这里只做装配与生命周期：玩法全在 core（纯逻辑），画面在 scenes/render，
 * 界面在 ui，落盘在 render/storage。改玩法不用动这个文件。
 */

const container = document.querySelector<HTMLDivElement>('#app')

if (container === null) {
  throw new Error('#app 容器不存在，请检查 index.html')
}

/** 收窄后的容器引用（供下面的函数闭包使用） */
const root: HTMLDivElement = container

/** 启动阶段就失败（配置错、浏览器不支持 WebGL）时的整页提示 */
function renderFatal(error: unknown): void {
  const isConfigError = error instanceof ConfigValidationError
  const issues = isConfigError ? error.issues : [error instanceof Error ? error.message : String(error)]

  const card = document.createElement('section')
  card.className = 'card card--error config-error'

  const title = document.createElement('h1')
  title.className = 'status status--error'
  title.textContent = isConfigError ? '配置校验失败' : '启动失败'
  card.append(title)

  const list = document.createElement('ol')
  list.className = 'issues'
  for (const issue of issues) {
    const item = document.createElement('li')
    item.textContent = issue
    list.append(item)
  }
  card.append(list)

  const hint = document.createElement('p')
  hint.className = 'hint'
  hint.textContent = isConfigError
    ? '修复 config/ 下的 JSON 后刷新页面；命令行可跑 npm run check-config 复现。'
    : '若是浏览器不支持 WebGL，请换 Chrome / Edge 再试。'
  card.append(hint)

  root.append(card)
}

async function boot(): Promise<void> {
  const config = loadConfig()
  const store = browserStore()
  const now = Date.now()

  const loaded = loadSave(store, config, now)
  // 新档立刻落盘：玩家哪怕什么都没做就关掉，下次进来也是同一份档
  if (loaded.created) writeSave(store, loaded.save, now)
  if (loaded.repairs.length > 0) console.warn('[save] 读档提示', loaded.repairs)

  const controller = new PickupController({
    config,
    store,
    save: loaded.save,
    log: loadAnalyticsLog(store),
    created: loaded.created,
    savedAt: loaded.savedAt,
    repairs: loaded.repairs,
  })
  controller.beginSession(now)

  const stage = document.createElement('div')
  stage.id = 'stage'
  const panel = document.createElement('aside')
  panel.id = 'panel'
  root.append(stage, panel)

  const app = await createGameApp(stage)
  syncCanvasSize(app, stage)

  // 两个场景共用一块画布，按控制器的阶段显隐（街上捡东西 / 垃圾场称重）
  const scene = new PickupScene(app, controller, config)
  scene.mount()
  const yard = new YardScene(app, controller, config)
  yard.mount()

  const syncPhase = (): void => {
    const inYard = controller.snapshot().phase === 'yard'
    scene.setVisible(!inYard)
    yard.setVisible(inYard)
    if (inYard) yard.start()
  }

  controller.subscribe(syncPhase)
  syncPhase()
  mountGamePanel({ host: panel, controller, config })

  window.addEventListener('resize', () => {
    if (syncCanvasSize(app, stage)) {
      scene.layout()
      yard.layout()
    }
  })
  window.addEventListener('beforeunload', () => controller.endSession(Date.now()))

  const snapshot = controller.snapshot()
  console.info('[game] ready', {
    zone: snapshot.zoneName,
    stamina: snapshot.stamina,
    bag: `${snapshot.bagUsed}/${snapshot.bagCapacity}`,
    saveCreated: loaded.created,
  })

  if (import.meta.env.DEV) {
    // 开发期调试句柄（T8 的调试面板会在此基础上做成 UI；生产构建里这段会被静态剔除）
    Reflect.set(window, '__pickAndLuck', { config, controller, scene, yard, app })
  }
}

boot().catch((error: unknown) => {
  console.error('[boot] 启动失败', error)
  renderFatal(error)
})
