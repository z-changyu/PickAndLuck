import type { FrozenGameConfig } from '../config/loader'
import { ANALYTICS_EVENT_NAMES, ANALYTICS_LOG_CAPACITY, createAnalyticsLog } from '../core/analytics'
import type { AnalyticsEvent, AnalyticsLog } from '../core/analytics'
import { SaveError, applyOfflineStamina, createNewGame, parseSave, serializeSave } from '../core/save'
import type { GameSave } from '../core/save'

/**
 * 存档落盘（平台适配层）。
 *
 * core/save.ts 是纯逻辑、不碰存储；所有平台 API 只出现在这个文件里：
 *   阶段一 → localStorage
 *   阶段二 → wx.setStorageSync（只改这里，core 一行不动）
 *
 * 单测用 Map 实现 KeyValueStore 即可，不需要浏览器。
 */

export const SAVE_STORAGE_KEY = 'pick-and-luck/save'

/** 埋点日志单独一份：它不属于游戏状态，清档也不该把它一起清掉 */
export const ANALYTICS_STORAGE_KEY = 'pick-and-luck/analytics'

/** 最小存储接口：localStorage / wx storage / 测试用的 Map 都能满足 */
export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** 浏览器实现：本文件里唯一直接使用 localStorage 的地方 */
export const browserStore = (): KeyValueStore => localStorage

export interface LoadSaveResult {
  readonly save: GameSave
  /** true = 本地没有可用存档，已新建（含读档失败回落） */
  readonly created: boolean
  /** 存档落盘时间；新档为 null（埋点 app_open 会用到） */
  readonly savedAt: number | null
  /** 读档/新建过程中的修复说明，交给上层提示或打日志 */
  readonly repairs: readonly string[]
  /** 离线期间恢复的体力（新档为 0） */
  readonly recovered: number
}

/**
 * 取出可玩的存档：没有就新建；读不动（结构坏、版本不兼容）也新建，
 * 但把原因写进 repairs 交给上层，而不是静默吞掉。
 * 读档时顺带结算离线体力（上限由 config 的 offlineStaminaCapHours 决定）。
 */
export function loadSave(store: KeyValueStore, config: FrozenGameConfig, now: number): LoadSaveResult {
  const raw = store.getItem(SAVE_STORAGE_KEY)
  if (raw === null) {
    return { save: createNewGame(config), created: true, savedAt: null, repairs: [], recovered: 0 }
  }

  try {
    const { save, savedAt, repairs } = parseSave(raw, config)
    const settled = applyOfflineStamina(save, savedAt, now, config)
    return { save: settled.save, created: false, savedAt, repairs, recovered: settled.recovered }
  } catch (error) {
    const reason = error instanceof SaveError ? error.message : String(error)
    return {
      save: createNewGame(config),
      created: true,
      savedAt: null,
      repairs: [`本地存档无法读取，已新建：${reason}`],
      recovered: 0,
    }
  }
}

/** 覆盖写入（savedAt 由调用方传入，core 不读时钟） */
export function writeSave(store: KeyValueStore, save: GameSave, now: number): void {
  store.setItem(SAVE_STORAGE_KEY, serializeSave(save, now))
}

/** 清档（调试面板的「清档」按钮用） */
export function clearSave(store: KeyValueStore): void {
  store.removeItem(SAVE_STORAGE_KEY)
}

// ---------------------------------------------------------------- 埋点日志

/** 一条事件是否长得像契约里的样子（埋点数据坏了就丢，不能拖垮游戏） */
function isAnalyticsEvent(value: unknown): value is AnalyticsEvent {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { name?: unknown; at?: unknown; payload?: unknown }
  return (
    typeof candidate.name === 'string' &&
    (ANALYTICS_EVENT_NAMES as readonly string[]).includes(candidate.name) &&
    typeof candidate.at === 'number' &&
    typeof candidate.payload === 'object' &&
    candidate.payload !== null
  )
}

/** 读埋点日志：坏数据直接丢弃重建（埋点不该影响游戏） */
export function loadAnalyticsLog(store: KeyValueStore): AnalyticsLog {
  const raw = store.getItem(ANALYTICS_STORAGE_KEY)
  if (raw === null) return createAnalyticsLog()

  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return createAnalyticsLog()
    const events = (parsed as { events?: unknown }).events
    if (!Array.isArray(events)) return createAnalyticsLog()
    return { events: events.filter(isAnalyticsEvent).slice(-ANALYTICS_LOG_CAPACITY) }
  } catch {
    return createAnalyticsLog()
  }
}

/** 覆盖写入埋点日志 */
export function writeAnalyticsLog(store: KeyValueStore, log: AnalyticsLog): void {
  store.setItem(ANALYTICS_STORAGE_KEY, JSON.stringify({ events: log.events }))
}
