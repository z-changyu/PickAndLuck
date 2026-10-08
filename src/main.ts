import './ui/theme.css'

import { ConfigValidationError, loadConfig } from './config/loader'
import type { FrozenGameConfig } from './config/loader'
import { staminaRefillMinutes } from './config/schema'
import { analyticsTargetsOf, checkTargets, createAnalyticsLog, currentSession, summarize, trackEvent } from './core/analytics'
import type { AnalyticsLog } from './core/analytics'
import {
  browserStore,
  loadAnalyticsLog,
  loadSave,
  writeAnalyticsLog,
  writeSave,
} from './render/storage'

/**
 * 阶段一的入口：保证「配置校验」「存档读写」「埋点本地日志」三条链路是活的。
 * 真正的渲染层（PixiJS）与场景（拾取 / 垃圾场 / 盲盒货架 / 升级商店）在 T5–T8 任务卡中实现。
 */

/** 展示用的时间换算常量（渲染层本地常量） */
const MINUTE_MS = 60_000

const store = browserStore()
let analyticsLog: AnalyticsLog = createAnalyticsLog()

const root = document.querySelector<HTMLDivElement>('#app')

if (root === null) {
  throw new Error('#app 容器不存在，请检查 index.html')
}

function heading(text: string, tone: 'ok' | 'error'): HTMLHeadingElement {
  const node = document.createElement('h1')
  node.className = `status status--${tone}`
  node.textContent = text
  return node
}

function metaList(rows: Array<[string, string]>): HTMLDListElement {
  const list = document.createElement('dl')
  list.className = 'meta'
  for (const [label, value] of rows) {
    const dt = document.createElement('dt')
    dt.textContent = label
    const dd = document.createElement('dd')
    dd.textContent = value
    list.append(dt, dd)
  }
  return list
}

interface SaveStatus {
  readonly created: boolean
  readonly savedAt: number | null
  readonly repairs: readonly string[]
  readonly row: [string, string]
}

/** 读一次存档（首次进入会自动建新档），整理成一行展示文案 */
function saveStatus(config: FrozenGameConfig): SaveStatus {
  const now = Date.now()
  const loaded = loadSave(store, config, now)

  if (loaded.created) {
    // 新档立刻落盘：玩家哪怕什么都没做就关掉，下次进来也是同一份档
    writeSave(store, loaded.save, now)
    const note = loaded.repairs.length > 0 ? '（旧存档不可用）' : ''
    return { created: true, savedAt: null, repairs: loaded.repairs, row: ['存档', `已新建${note}`] }
  }

  const repaired = loaded.repairs.length > 0 ? ` · ${loaded.repairs.length} 项修复` : ''
  return {
    created: false,
    savedAt: loaded.savedAt,
    repairs: loaded.repairs,
    row: ['存档', `已读取 · 离线恢复 ${Math.round(loaded.recovered)} 点体力${repaired}`],
  }
}

/** 启动时记 app_open 并立刻落盘（崩溃也不丢） */
function bootAnalytics(status: SaveStatus): void {
  analyticsLog = trackEvent(loadAnalyticsLog(store), {
    name: 'app_open',
    at: Date.now(),
    payload: { isNewGame: status.created, savedAt: status.savedAt },
  })
  writeAnalyticsLog(store, analyticsLog)
}

/** 关页时记 session_end；时长/趟数/出售额由 core 的 currentSession 算 */
function endAnalyticsSession(): void {
  const at = Date.now()
  const session = currentSession(analyticsLog, at)
  if (session.startedAt === null) return

  writeAnalyticsLog(
    store,
    trackEvent(analyticsLog, {
      name: 'session_end',
      at,
      payload: { durationMs: session.durationMs, trips: session.trips, sold: session.sold },
    }),
  )
}

/** 埋点卡片：本地日志汇总 + 与 config 里的验收指标逐条比对 */
function analyticsView(config: FrozenGameConfig): HTMLElement {
  const card = document.createElement('section')
  card.className = 'card'

  const summary = summarize(analyticsLog)
  const minutes = (ms: number | null): string => (ms === null ? '—' : `${(ms / MINUTE_MS).toFixed(1)} 分钟`)

  card.append(
    heading('埋点（本地日志）', 'ok'),
    metaList([
      [
        '事件数',
        `${summary.eventCount} 条（启动 ${summary.appOpens} 次 · 活跃 ${summary.activeDays} 天 · 完整会话 ${summary.sessions} 次）`,
      ],
      [
        '上次会话',
        summary.lastSessionMs === null ? '—' : `${minutes(summary.lastSessionMs)} · ${summary.lastSessionTrips} 趟`,
      ],
      ['货架→购买转化', summary.buyConversion === null ? '—' : `${(summary.buyConversion * 100).toFixed(1)}%`],
      ['首次开箱耗时', minutes(summary.firstGachaOpenMs)],
    ]),
    metaList(
      checkTargets(summary, analyticsTargetsOf(config)).map((check) => [
        `${check.ok ? '✓' : '✗'} ${check.label}`,
        `实际 ${check.actualText} / 目标 ${check.targetText}`,
      ]),
    ),
  )

  return card
}

function okView(config: FrozenGameConfig, saveRow: [string, string]): HTMLElement {
  const card = document.createElement('section')
  card.className = 'card'
  card.append(
    heading('配置校验通过', 'ok'),
    metaList([
      ['游戏', `${config.global.game.name} · ${config.global.game.subtitle}`],
      ['稀有度', `${config.rarity.rarities.length} 档`],
      ['街头物品', `${config.items.items.length} 件`],
      ['区域', `${config.zones.zones.length} 个`],
      ['盲盒', `${config.gacha.boxes.length} 款`],
      ['载具', `${config.vehicles.vehicles.length} 级`],
      ['体力', `上限 ${config.global.player.maxStamina} · 满仓 ${staminaRefillMinutes(config.global.player)} 分钟`],
      saveRow,
    ]),
  )
  return card
}

function errorView(error: unknown): HTMLElement {
  const card = document.createElement('section')
  card.className = 'card card--error'

  const issues = error instanceof ConfigValidationError ? error.issues : [String(error)]

  card.append(heading('配置校验失败', 'error'))

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
  hint.textContent = '修复 config/ 下的 JSON 后刷新页面；命令行可跑 npm run check-config 复现。'
  card.append(hint)

  return card
}

try {
  const config = loadConfig()
  console.info('[config] 校验通过', {
    zones: config.zones.zones.length,
    items: config.items.items.length,
    boxes: config.gacha.boxes.length,
  })

  const status = saveStatus(config)
  if (status.repairs.length > 0) console.warn('[save] 读档提示', status.repairs)

  bootAnalytics(status)
  window.addEventListener('beforeunload', endAnalyticsSession)

  root.append(okView(config, status.row))
  root.append(analyticsView(config))
} catch (error) {
  console.error('[config] 校验失败', error)
  root.append(errorView(error))
}
