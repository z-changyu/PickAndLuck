import { describe, expect, it } from 'vitest'

import { loadConfig } from '../../src/config/loader'
import { createAnalyticsLog, trackEvent } from '../../src/core/analytics'
import { SAVE_VERSION, createNewGame, serializeSave } from '../../src/core/save'
import {
  ANALYTICS_STORAGE_KEY,
  SAVE_STORAGE_KEY,
  clearSave,
  loadAnalyticsLog,
  loadSave,
  writeAnalyticsLog,
  writeSave,
} from '../../src/render/storage'
import type { KeyValueStore } from '../../src/render/storage'

const config = loadConfig()
const NOW = 1_760_000_000_000

/** 用 Map 实现的最小存储：测存档流程不需要浏览器 */
const createStore = (): KeyValueStore => {
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  }
}

const saveWithStamina = (stamina: number) => {
  const base = createNewGame(config)
  return { ...base, player: { ...base.player, stamina } }
}

describe('storage · 首次进入', () => {
  it('没有存档 → 新建，且不写盘', () => {
    const store = createStore()
    const result = loadSave(store, config, NOW)

    expect(result.created).toBe(true)
    expect(result.recovered).toBe(0)
    expect(result.repairs).toEqual([])
    expect(result.save.player.vehicleId).toBe(config.global.player.initialVehicle)
    expect(store.getItem(SAVE_STORAGE_KEY)).toBeNull()
  })
})

describe('storage · 读档', () => {
  it('写入后能读回，并自动结算离线体力', () => {
    const store = createStore()
    writeSave(store, saveWithStamina(0), NOW)

    const result = loadSave(store, config, NOW + 30 * 60 * 1000) // 离线 30 分钟

    expect(result.created).toBe(false)
    expect(result.recovered).toBeCloseTo(30 * config.global.player.staminaRecoverPerMinute, 10)
    expect(result.save.player.stamina).toBeCloseTo(result.recovered, 10)
  })

  it('离线超过封顶时长也只恢复到上限', () => {
    const store = createStore()
    writeSave(store, saveWithStamina(0), NOW)

    const result = loadSave(store, config, NOW + 72 * 60 * 60 * 1000) // 离线 3 天
    expect(result.save.player.stamina).toBe(config.global.player.maxStamina)
  })

  it('存档损坏 → 回落新档，并把原因记进 repairs（不静默）', () => {
    const store = createStore()
    store.setItem(SAVE_STORAGE_KEY, '{损坏的存档')

    const result = loadSave(store, config, NOW)
    expect(result.created).toBe(true)
    expect(result.repairs.join('\n')).toContain('无法读取')
    expect(result.save.player.money).toBe(config.global.player.initialMoney)
  })

  it('存档版本比客户端新 → 同样回落新档并说明原因', () => {
    const store = createStore()
    store.setItem(SAVE_STORAGE_KEY, JSON.stringify({ version: SAVE_VERSION + 1, savedAt: NOW, game: {} }))

    const result = loadSave(store, config, NOW)
    expect(result.created).toBe(true)
    expect(result.repairs.join('\n')).toContain('请升级客户端')
  })

  it('读档修复会透传给上层（例如物品已被删除）', () => {
    const store = createStore()
    const wire = JSON.parse(serializeSave(createNewGame(config), NOW)) as {
      game: { inventory: Array<{ id: string; condition: string }> }
    }
    wire.game.inventory = [{ id: 'atlantis', condition: 'pristine' }]
    store.setItem(SAVE_STORAGE_KEY, JSON.stringify(wire))

    const result = loadSave(store, config, NOW)
    expect(result.created).toBe(false)
    expect(result.repairs.join('\n')).toContain('atlantis')
  })
})

describe('storage · 清档', () => {
  it('清档后再次读取会新建', () => {
    const store = createStore()
    writeSave(store, createNewGame(config), NOW)
    expect(loadSave(store, config, NOW).created).toBe(false)

    clearSave(store)
    expect(loadSave(store, config, NOW).created).toBe(true)
  })
})

describe('storage · 埋点日志', () => {
  const appOpen = (at: number) =>
    trackEvent(createAnalyticsLog(), {
      name: 'app_open',
      at,
      payload: { isNewGame: true, savedAt: null },
    })

  it('写入后能读回', () => {
    const store = createStore()
    writeAnalyticsLog(store, appOpen(NOW))

    expect(loadAnalyticsLog(store).events).toHaveLength(1)
    expect(loadAnalyticsLog(store).events[0]?.name).toBe('app_open')
  })

  it('没有日志 → 空日志', () => {
    expect(loadAnalyticsLog(createStore()).events).toEqual([])
  })

  it('坏数据 → 丢弃重建，不抛错（埋点不该拖垮游戏）', () => {
    const store = createStore()
    store.setItem(ANALYTICS_STORAGE_KEY, '{坏掉的')
    expect(loadAnalyticsLog(store).events).toEqual([])

    // 结构不对的事件被过滤掉，合法的留下
    store.setItem(
      ANALYTICS_STORAGE_KEY,
      JSON.stringify({
        events: [
          { name: 'not_a_real_event', at: 1, payload: {} },
          { name: 'app_open', at: 1, payload: {} },
        ],
      }),
    )
    expect(loadAnalyticsLog(store).events.map((event) => event.name)).toEqual(['app_open'])
  })

  it('清档不影响埋点日志（两份数据分开存）', () => {
    const store = createStore()
    writeSave(store, createNewGame(config), NOW)
    writeAnalyticsLog(store, appOpen(NOW))

    clearSave(store)

    expect(store.getItem(SAVE_STORAGE_KEY)).toBeNull()
    expect(loadAnalyticsLog(store).events).toHaveLength(1)
  })
})
