import { describe, expect, it } from 'vitest'

import { loadConfig } from '../../src/config/loader'
import {
  ANALYTICS_EVENT_NAMES,
  ANALYTICS_LOG_CAPACITY,
  analyticsTargetsOf,
  checkTargets,
  createAnalyticsLog,
  currentSession,
  hasEvent,
  summarize,
  trackEvent,
} from '../../src/core/analytics'

const config = loadConfig()
const T0 = 1_760_000_000_000
const MINUTE = 60_000

const appOpen = (at: number) =>
  ({ name: 'app_open', at, payload: { isNewGame: false, savedAt: at - 1 } }) as const
const trip = (at: number, sold = 10) =>
  ({ name: 'trip_complete', at, payload: { zoneId: 'street_alley', itemCount: 6, sold, expGained: sold } }) as const
const shelf = (at: number) => ({ name: 'gacha_shelf_enter', at, payload: { boxCount: 5 } }) as const
const buy = (at: number) =>
  ({ name: 'gacha_buy', at, payload: { boxId: 'junk_box', price: 10, isFirstBuy: true } }) as const
const firstOpen = (at: number, elapsedMs = 5 * MINUTE) =>
  ({ name: 'first_gacha_open', at, payload: { elapsedMs, boxId: 'junk_box', rarity: 'purple' } }) as const
const sessionEnd = (at: number, durationMs: number, trips: number, sold: number) =>
  ({ name: 'session_end', at, payload: { durationMs, trips, sold } }) as const

describe('analytics · 事件契约', () => {
  it('事件名与启动包 README 第 6 节定死的 6 个一致（改名等于数据断档）', () => {
    expect([...ANALYTICS_EVENT_NAMES]).toEqual([
      'app_open',
      'trip_complete',
      'gacha_shelf_enter',
      'gacha_buy',
      'first_gacha_open',
      'session_end',
    ])
  })

  it('记录事件不可变，顺序追加', () => {
    const log = createAnalyticsLog()
    const next = trackEvent(log, appOpen(T0))

    expect(log.events).toHaveLength(0)
    expect(next.events).toHaveLength(1)
    expect(next.events[0]?.name).toBe('app_open')
  })

  it('超出容量丢最旧的', () => {
    let log = createAnalyticsLog()
    for (let i = 0; i < ANALYTICS_LOG_CAPACITY + 5; i += 1) log = trackEvent(log, trip(T0 + i))

    expect(log.events).toHaveLength(ANALYTICS_LOG_CAPACITY)
    expect(log.events[0]?.at).toBe(T0 + 5)
  })

  it('hasEvent 用于 first_gacha_open 这种只记一次的事件', () => {
    const log = trackEvent(createAnalyticsLog(), firstOpen(T0))
    expect(hasEvent(log, 'first_gacha_open')).toBe(true)
    expect(hasEvent(log, 'session_end')).toBe(false)
  })
})

describe('analytics · 会话快照', () => {
  it('没有 app_open 时是空快照', () => {
    expect(currentSession(createAnalyticsLog(), T0)).toEqual({ startedAt: null, durationMs: 0, trips: 0, sold: 0 })
  })

  it('只统计本次会话内的 trip_complete（上次会话的不算）', () => {
    let log = createAnalyticsLog()
    log = trackEvent(log, appOpen(T0))
    log = trackEvent(log, trip(T0 + MINUTE, 5))
    log = trackEvent(log, appOpen(T0 + 60 * MINUTE))
    log = trackEvent(log, trip(T0 + 61 * MINUTE, 10))
    log = trackEvent(log, trip(T0 + 62 * MINUTE, 20))

    const session = currentSession(log, T0 + 65 * MINUTE)
    expect(session.startedAt).toBe(T0 + 60 * MINUTE)
    expect(session.durationMs).toBe(5 * MINUTE)
    expect(session.trips).toBe(2)
    expect(session.sold).toBe(30)
  })

  it('时钟回拨时长不为负', () => {
    const log = trackEvent(createAnalyticsLog(), appOpen(T0))
    expect(currentSession(log, T0 - MINUTE).durationMs).toBe(0)
  })
})

describe('analytics · 汇总与验收指标', () => {
  /** 一天两次启动、一次完整会话 8 分钟 3 趟、进一次货架买一次盒、首开 5 分钟 */
  const buildLog = () => {
    let log = createAnalyticsLog()
    log = trackEvent(log, appOpen(T0))
    log = trackEvent(log, trip(T0 + MINUTE))
    log = trackEvent(log, sessionEnd(T0 + 8 * MINUTE, 8 * MINUTE, 3, 30))
    log = trackEvent(log, appOpen(T0 + 24 * 60 * MINUTE))
    log = trackEvent(log, shelf(T0 + 24 * 60 * MINUTE + MINUTE))
    log = trackEvent(log, buy(T0 + 24 * 60 * MINUTE + 2 * MINUTE))
    log = trackEvent(log, firstOpen(T0 + 24 * 60 * MINUTE + 2 * MINUTE))
    return log
  }

  it('汇总出启动次数 / 活跃天数 / 上次会话 / 转化率 / 首次开箱耗时', () => {
    const summary = summarize(buildLog())

    expect(summary.eventCount).toBe(7)
    expect(summary.appOpens).toBe(2)
    expect(summary.activeDays).toBe(2)
    expect(summary.sessions).toBe(1)
    expect(summary.lastSessionMs).toBe(8 * MINUTE)
    expect(summary.lastSessionTrips).toBe(3)
    expect(summary.shelfEnters).toBe(1)
    expect(summary.buys).toBe(1)
    expect(summary.buyConversion).toBe(1)
    expect(summary.firstGachaOpenMs).toBe(5 * MINUTE)
  })

  it('没进过货架时转化率是 null（而不是 0）', () => {
    expect(summarize(trackEvent(createAnalyticsLog(), appOpen(T0))).buyConversion).toBeNull()
  })

  it('达标检查逐条给出实测与目标', () => {
    const byId = new Map(checkTargets(summarize(buildLog()), analyticsTargetsOf(config)).map((c) => [c.id, c]))

    expect(byId.get('session_duration')?.ok, '8 分钟 ∈ 6–10').toBe(true)
    expect(byId.get('session_duration')?.actualText).toBe('8.0 分钟')
    expect(byId.get('session_trips')?.ok, '3 ≥ 3').toBe(true)
    expect(byId.get('first_gacha_open')?.ok, '5 ≤ 12').toBe(true)
    expect(byId.get('gacha_buy_conversion')?.ok, '100% ≥ 60%').toBe(true)
    expect(byId.get('gacha_buy_conversion')?.targetText).toBe('≥ 60%')
  })

  it('空日志 → 四项全部未达标（MVP 阶段看的就是「还没跑出来」）', () => {
    const checks = checkTargets(summarize(createAnalyticsLog()), analyticsTargetsOf(config))

    expect(checks).toHaveLength(4)
    for (const check of checks) {
      expect(check.ok, check.id).toBe(false)
      expect(check.actualText).toBe('—')
    }
  })

  it('负例：会话过长 / 趟数不足 / 首开超时 → 对应项不达标', () => {
    let log = createAnalyticsLog()
    log = trackEvent(log, appOpen(T0))
    log = trackEvent(log, sessionEnd(T0 + 20 * MINUTE, 20 * MINUTE, 1, 5))
    log = trackEvent(log, firstOpen(T0 + 30 * MINUTE, 30 * MINUTE))

    const byId = new Map(checkTargets(summarize(log), analyticsTargetsOf(config)).map((c) => [c.id, c.ok]))
    expect(byId.get('session_duration'), '20 分钟 > 上限').toBe(false)
    expect(byId.get('session_trips'), '1 趟 < 3').toBe(false)
    expect(byId.get('first_gacha_open'), '30 分钟 > 12').toBe(false)
  })
})
