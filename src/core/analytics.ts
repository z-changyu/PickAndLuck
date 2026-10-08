import type { FrozenGameConfig } from '../config/loader'
import type { RarityId } from '../config/schema'

/**
 * 埋点：本地日志版。
 *
 * 启动包 README 第 6 节的原话：「MVP 阶段先用本地日志 + 调试面板看，
 * 但事件名和结构现在就定死，后面接分析平台不用返工。」
 * 所以这里只做三件事：**定死事件契约**、记录事件、算派生指标。
 * 落盘由 render/storage.ts 负责；上报给分析平台是以后的事。
 *
 * 纯逻辑：时间一律由调用方传入（core 不读时钟），因此完全可测、可复现。
 */

/** 事件名 —— 对外契约。一旦上线，改名等于数据断档 */
export const ANALYTICS_EVENT_NAMES = [
  'app_open',
  'trip_complete',
  'gacha_shelf_enter',
  'gacha_buy',
  'first_gacha_open',
  'session_end',
] as const
export type AnalyticsEventName = (typeof ANALYTICS_EVENT_NAMES)[number]

/** 每个事件带什么字段 —— 改这里等于改数据契约，必须同步 design/ 与文档 */
export interface AnalyticsEventPayloads {
  /** 每次启动。isNewGame = 本地没有档（首次进入）；savedAt 为新档落地时间 */
  readonly app_open: { readonly isNewGame: boolean; readonly savedAt: number | null }
  /** 完成一趟：哪个区域、捡了几件、卖了多少、涨了多少经验 */
  readonly trip_complete: {
    readonly zoneId: string
    readonly itemCount: number
    readonly sold: number
    readonly expGained: number
  }
  /** 进入盲盒货架 —— 购买转化率的分母 */
  readonly gacha_shelf_enter: { readonly boxCount: number }
  /** 买了一次盲盒 —— 购买转化率的分子 */
  readonly gacha_buy: { readonly boxId: string; readonly price: number; readonly isFirstBuy: boolean }
  /** 首次开箱（每账号一次）：从首次进游戏起算的耗时，目标 ≤ firstGachaOpenMinutesMax */
  readonly first_gacha_open: { readonly elapsedMs: number; readonly boxId: string; readonly rarity: RarityId }
  /** 会话结束：时长、趟数、出售额 */
  readonly session_end: { readonly durationMs: number; readonly trips: number; readonly sold: number }
}

/** 事件（判别联合：name 决定 payload 的形状，写错编译期就报） */
export type AnalyticsEvent = {
  [K in AnalyticsEventName]: {
    readonly name: K
    readonly at: number
    readonly payload: AnalyticsEventPayloads[K]
  }
}[AnalyticsEventName]

/** 本地日志容量上限（技术常量，超出丢最旧的）：够 MVP 复盘，又不会把本地存储撑爆 */
export const ANALYTICS_LOG_CAPACITY = 500

export interface AnalyticsLog {
  readonly events: readonly AnalyticsEvent[]
}

export const createAnalyticsLog = (): AnalyticsLog => ({ events: [] })

/** 追加一个事件（不可变；超出容量时丢最旧的） */
export function trackEvent(log: AnalyticsLog, event: AnalyticsEvent): AnalyticsLog {
  const events = [...log.events, event]
  const trimmed = events.length > ANALYTICS_LOG_CAPACITY ? events.slice(events.length - ANALYTICS_LOG_CAPACITY) : events
  return { events: trimmed }
}

/** 是否已经记过某个事件（例如 first_gacha_open 只记一次） */
export const hasEvent = (log: AnalyticsLog, name: AnalyticsEventName): boolean =>
  log.events.some((event) => event.name === name)

/** 时间单位换算（毫秒 → 分钟），与游戏数值无关 */
const MS_PER_MINUTE = 60_000

/** UTC 自然日键。这里只用 UTC 分桶做本地汇总，原始时间戳都存着，分析侧可按任意时区重算 */
const dayKeyOf = (at: number): string => new Date(at).toISOString().slice(0, 10)

/** 本次会话快照：起点、已时长、趟数、出售额（趟数/出售额只统计本次会话内的 trip_complete） */
export interface SessionSnapshot {
  readonly startedAt: number | null
  readonly durationMs: number
  readonly trips: number
  readonly sold: number
}

export function currentSession(log: AnalyticsLog, at: number): SessionSnapshot {
  let startedAt: number | null = null
  for (const event of log.events) if (event.name === 'app_open') startedAt = event.at
  if (startedAt === null) return { startedAt: null, durationMs: 0, trips: 0, sold: 0 }

  let trips = 0
  let sold = 0
  for (const event of log.events) {
    if (event.name !== 'trip_complete' || event.at < startedAt) continue
    trips += 1
    sold += event.payload.sold
  }
  return { startedAt, durationMs: Math.max(0, at - startedAt), trips, sold }
}

export interface AnalyticsSummary {
  readonly eventCount: number
  readonly appOpens: number
  /** 有 app_open 的不同天数（UTC 分桶） */
  readonly activeDays: number
  readonly sessions: number
  /** 最近一次会话时长；还没结束过会话时为 null */
  readonly lastSessionMs: number | null
  readonly lastSessionTrips: number
  readonly shelfEnters: number
  readonly buys: number
  /** 货架 → 购买转化率；没进过货架时为 null */
  readonly buyConversion: number | null
  /** 首次开箱耗时；还没开过箱时为 null */
  readonly firstGachaOpenMs: number | null
}

export function summarize(log: AnalyticsLog): AnalyticsSummary {
  let appOpens = 0
  let sessions = 0
  let shelfEnters = 0
  let buys = 0
  let lastSessionMs: number | null = null
  let lastSessionTrips = 0
  let firstGachaOpenMs: number | null = null
  const days = new Set<string>()

  for (const event of log.events) {
    switch (event.name) {
      case 'app_open':
        appOpens += 1
        days.add(dayKeyOf(event.at))
        break
      case 'trip_complete':
        break
      case 'gacha_shelf_enter':
        shelfEnters += 1
        break
      case 'gacha_buy':
        buys += 1
        break
      case 'first_gacha_open':
        firstGachaOpenMs = firstGachaOpenMs ?? event.payload.elapsedMs
        break
      case 'session_end':
        sessions += 1
        lastSessionMs = event.payload.durationMs
        lastSessionTrips = event.payload.trips
        break
    }
  }

  return {
    eventCount: log.events.length,
    appOpens,
    activeDays: days.size,
    sessions,
    lastSessionMs,
    lastSessionTrips,
    shelfEnters,
    buys,
    buyConversion: shelfEnters > 0 ? buys / shelfEnters : null,
    firstGachaOpenMs,
  }
}

/** 验收指标（来自 config.global.analytics） */
export interface AnalyticsTargets {
  readonly sessionMinutesMin: number
  readonly sessionMinutesMax: number
  readonly sessionTripsMin: number
  readonly firstGachaOpenMinutesMax: number
  readonly gachaBuyConversionMin: number
}

export interface TargetCheck {
  readonly id: string
  readonly label: string
  /** 已格式化的实测值；没观测到就是 '—' */
  readonly actualText: string
  readonly targetText: string
  /** 未观测到算未达标：MVP 阶段看的就是「还没跑出来」 */
  readonly ok: boolean
}

const formatMinutes = (ms: number | null): string =>
  ms === null ? '—' : `${(ms / MS_PER_MINUTE).toFixed(1)} 分钟`

const formatPercent = (ratio: number | null): string =>
  ratio === null ? '—' : `${(ratio * 100).toFixed(1)}%`

/** 把汇总结果与 config 里的目标值逐条比对（调试面板直接展示） */
export function checkTargets(summary: AnalyticsSummary, targets: AnalyticsTargets): TargetCheck[] {
  const sessionMinutes = summary.lastSessionMs === null ? null : summary.lastSessionMs / MS_PER_MINUTE

  return [
    {
      id: 'session_duration',
      label: '单次会话时长',
      actualText: formatMinutes(summary.lastSessionMs),
      targetText: `${targets.sessionMinutesMin}–${targets.sessionMinutesMax} 分钟`,
      ok:
        sessionMinutes !== null &&
        sessionMinutes >= targets.sessionMinutesMin &&
        sessionMinutes <= targets.sessionMinutesMax,
    },
    {
      id: 'session_trips',
      label: '单次会话趟数',
      actualText: summary.sessions === 0 ? '—' : `${summary.lastSessionTrips} 趟`,
      targetText: `≥ ${targets.sessionTripsMin} 趟`,
      ok: summary.sessions > 0 && summary.lastSessionTrips >= targets.sessionTripsMin,
    },
    {
      id: 'first_gacha_open',
      label: '首次开箱耗时',
      actualText: formatMinutes(summary.firstGachaOpenMs),
      targetText: `≤ ${targets.firstGachaOpenMinutesMax} 分钟`,
      ok:
        summary.firstGachaOpenMs !== null &&
        summary.firstGachaOpenMs <= targets.firstGachaOpenMinutesMax * MS_PER_MINUTE,
    },
    {
      id: 'gacha_buy_conversion',
      label: '货架→购买转化',
      actualText: formatPercent(summary.buyConversion),
      targetText: `≥ ${(targets.gachaBuyConversionMin * 100).toFixed(0)}%`,
      ok: summary.buyConversion !== null && summary.buyConversion >= targets.gachaBuyConversionMin,
    },
  ]
}

/** 便捷：直接拿 config 里的目标值 */
export const analyticsTargetsOf = (config: FrozenGameConfig): AnalyticsTargets => config.global.analytics
