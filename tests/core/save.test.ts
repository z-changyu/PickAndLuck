import { describe, expect, it } from 'vitest'

import { loadConfig } from '../../src/config/loader'
import type { FrozenGameConfig } from '../../src/config/loader'
import type { PickedItem } from '../../src/core/pickup'
import { defaultZone } from '../../src/core/progression'
import { createRngFromState } from '../../src/core/rng'
import {
  SAVE_VERSION,
  SaveError,
  applyOfflineStamina,
  createNewGame,
  parseSave,
  restoreRng,
  saveCapacity,
  saveLevel,
  serializeSave,
} from '../../src/core/save'
import type { GameSave } from '../../src/core/save'

const config = loadConfig()
const SAVED_AT = 1_760_000_000_000

const itemOf = (id: string) => {
  const item = config.items.items.find((candidate) => candidate.id === id)
  if (item === undefined) throw new Error(`测试数据缺少物品 ${id}`)
  return item
}

const picked = (id: string, condition: PickedItem['condition'] = 'pristine'): PickedItem => ({
  item: itemOf(id),
  condition,
})

/** 取出线格式（wire）便于按需改坏 */
const wireOf = (save: GameSave, savedAt = SAVED_AT) =>
  JSON.parse(serializeSave(save, savedAt)) as {
    version: number
    savedAt: number
    game: {
      player: { money: number; stamina: number; vehicleId: string; gridExpansions: number; exp: number; zoneId: string }
      inventory: Array<{ id: string; condition: string }>
      gacha: { pityCounters: Record<string, number>; openCount: number; owned: string[]; shards: number }
      rng: { seed: number; state: number }
      stats: { trips: number; earnedTotal: number }
    }
  }

const cloneWire = (save: GameSave) => wireOf(save)

describe('save · 新档', () => {
  it('所有初值都来自 config（含随机种子与默认区域）', () => {
    const save = createNewGame(config)

    expect(save.player.money).toBe(config.global.player.initialMoney)
    expect(save.player.stamina).toBe(config.global.player.initialStamina)
    expect(save.player.vehicleId).toBe(config.global.player.initialVehicle)
    expect(save.player.gridExpansions).toBe(0)
    expect(save.player.exp).toBe(0)
    expect(save.player.zoneId).toBe(defaultZone(config).id)
    expect(save.player.zoneId).toBe('street_alley')
    expect(save.rng.seed).toBe(config.global.debug.rngSeed)
    expect(save.inventory.capacity).toBe(saveCapacity(save, config))
    expect(save.inventory.items).toHaveLength(0)
    expect(save.gacha.openCount).toBe(0)
    expect(save.stats).toEqual({ trips: 0, earnedTotal: 0 })
    expect(saveLevel(save, config)).toBe(1)
  })

  it('新档的随机状态就是种子本身（还没消耗随机数）', () => {
    const save = createNewGame(config)
    expect(save.rng.state).toBe(createRngFromState(save.rng.state).state)
    expect(save.rng.state).toBeGreaterThanOrEqual(0)
  })
})

describe('save · 往返（serialize → parse）', () => {
  it('无修复地原样读回，且 savedAt 透传', () => {
    const base = createNewGame(config)
    const save: GameSave = {
      player: { ...base.player, money: 123.5, stamina: 42, exp: 640, gridExpansions: 2 },
      rng: base.rng,
      inventory: { capacity: base.inventory.capacity, items: [picked('plastic_bottle'), picked('old_appliance', 'worn')] },
      gacha: { pityCounters: { junk_box: 7 }, openCount: 33, owned: ['junk_box:purple'], shards: 25 },
      stats: { trips: 9, earnedTotal: 456.75 },
    }

    const text = serializeSave(save, SAVED_AT)
    const wire = JSON.parse(text) as { version: number; savedAt: number }
    expect(wire.version).toBe(SAVE_VERSION)
    expect(wire.savedAt).toBe(SAVED_AT)

    const { save: loaded, savedAt, repairs } = parseSave(text, config)
    expect(repairs).toEqual([])
    expect(savedAt, '落盘时间要带出来，离线体力结算依赖它').toBe(SAVED_AT)
    expect(loaded.player.money).toBe(123.5)
    expect(loaded.player.stamina).toBe(42)
    expect(loaded.player.exp).toBe(640)
    expect(loaded.player.gridExpansions).toBe(2)
    expect(loaded.stats).toEqual({ trips: 9, earnedTotal: 456.75 })
    expect(loaded.gacha).toEqual({ pityCounters: { junk_box: 7 }, openCount: 33, owned: ['junk_box:purple'], shards: 25 })
    expect(loaded.inventory.items).toHaveLength(2)
    expect(loaded.inventory.items[1]?.condition).toBe('worn')
    expect(loaded.rng).toEqual(save.rng)
  })

  it('读档后随机序列接着走（不是从种子重来）', () => {
    const save = createNewGame(config)
    const before = restoreRng(save)
    const expected = [before.next(), before.next(), before.next()]

    const { save: loaded } = parseSave(serializeSave(save, SAVED_AT), config)
    const after = restoreRng(loaded)

    expect([after.next(), after.next(), after.next()]).toEqual(expected)
  })

  it('物品只落 id 与品相，容量等派生值不落盘', () => {
    const base = createNewGame(config)
    const save: GameSave = {
      ...base,
      inventory: { capacity: base.inventory.capacity, items: [picked('old_appliance', 'broken')] },
    }

    const text = serializeSave(save, SAVED_AT)
    expect(text).toContain('"id":"old_appliance"')
    expect(text).toContain('"condition":"broken"')
    expect(text).not.toContain('unitPrice')
    expect(text).not.toContain('gridCost')
    expect(text).not.toContain('capacity')

    const { save: loaded } = parseSave(text, config)
    expect(loaded.inventory.capacity, '容量由载具 + 扩容重算').toBe(6)
    expect(loaded.inventory.items).toHaveLength(1)
  })

  it('物品价格取「当前配置」而不是存档里的旧值（config 是权威）', () => {
    const base = createNewGame(config)
    const text = serializeSave({ ...base, inventory: { capacity: 6, items: [picked('old_appliance')] } }, SAVED_AT)

    const mutated = structuredClone(config) as unknown as {
      items: { items: Array<{ id: string; unitPrice: number }> }
    }
    const target = mutated.items.items.find((item) => item.id === 'old_appliance')
    if (target === undefined) throw new Error('测试数据缺少 old_appliance')
    target.unitPrice = 999

    const { save: loaded } = parseSave(text, mutated as unknown as FrozenGameConfig)
    expect(loaded.inventory.items[0]?.item.unitPrice).toBe(999)
  })
})

describe('save · 坏数据必须报错（不静默）', () => {
  it('不是 JSON', () => {
    expect(() => parseSave('这不是存档', config)).toThrow(SaveError)
    expect(() => parseSave('{"version":', config)).toThrow(/不是合法 JSON/)
  })

  it('缺少 version 字段', () => {
    expect(() => parseSave(JSON.stringify({ savedAt: 1, game: {} }), config)).toThrow(/无法识别格式/)
  })

  it('结构不合法（字段类型错）会点名具体字段', () => {
    const wire = cloneWire(createNewGame(config))
    wire.game.player.money = -1

    expect(() => parseSave(JSON.stringify(wire), config)).toThrow(/player.money/)
  })

  it('缺少 game 内容', () => {
    expect(() => parseSave(JSON.stringify({ version: 1, savedAt: 1, game: {} }), config)).toThrow(/内容不合法/)
  })

  it('存档版本比客户端新 → 提示升级而不是硬读', () => {
    const text = JSON.stringify({ version: SAVE_VERSION + 1, savedAt: 1, game: {} })
    expect(() => parseSave(text, config)).toThrow(/请升级客户端/)
  })

  it('老版本没有迁移函数 → 明确报错（不静默当新版解析）', () => {
    const text = JSON.stringify({ version: 0, savedAt: 1, game: {} })
    expect(() => parseSave(text, config)).toThrow(/缺少 v0/)
  })

  it('rng.state 为负数 → 拒绝', () => {
    const wire = cloneWire(createNewGame(config))
    wire.game.rng.state = -5
    expect(() => parseSave(JSON.stringify(wire), config)).toThrow(/rng.state/)
  })
})

describe('save · 读档修复（能修的修好，并记进 repairs）', () => {
  it('物品被删除 → 丢弃该物品并记录', () => {
    const wire = cloneWire(createNewGame(config))
    wire.game.inventory = [
      { id: 'plastic_bottle', condition: 'pristine' },
      { id: 'atlantis', condition: 'pristine' },
    ]

    const { save, repairs } = parseSave(JSON.stringify(wire), config)
    expect(save.inventory.items.map((entry) => entry.item.id)).toEqual(['plastic_bottle'])
    expect(repairs.join('\n')).toContain('atlantis')
  })

  it('载具被删除 → 回落初始载具，容量随之重算', () => {
    const wire = cloneWire(createNewGame(config))
    wire.game.player.vehicleId = 'spaceship'

    const { save, repairs } = parseSave(JSON.stringify(wire), config)
    expect(save.player.vehicleId).toBe(config.global.player.initialVehicle)
    expect(save.inventory.capacity).toBe(6)
    expect(repairs.join('\n')).toContain('spaceship')
  })

  it('区域已不存在或未解锁 → 回落默认区域', () => {
    const wire = cloneWire(createNewGame(config))
    wire.game.player.zoneId = 'landfill' // 需要 Lv20，而 exp = 0

    const { save, repairs } = parseSave(JSON.stringify(wire), config)
    expect(save.player.zoneId).toBe('street_alley')
    expect(repairs.join('\n')).toContain('Lv20')

    const gone = cloneWire(createNewGame(config))
    gone.game.player.zoneId = 'atlantis'
    expect(parseSave(JSON.stringify(gone), config).save.player.zoneId).toBe('street_alley')
  })

  it('体力超过当前上限 → 夹紧', () => {
    const wire = cloneWire(createNewGame(config))
    wire.game.player.stamina = 9999

    const { save, repairs } = parseSave(JSON.stringify(wire), config)
    expect(save.player.stamina).toBe(config.global.player.maxStamina)
    expect(repairs.join('\n')).toContain('夹紧')
  })

  it('背包装不下 → 丢弃超出容量的物品并记录', () => {
    const wire = cloneWire(createNewGame(config))
    wire.game.inventory = [
      { id: 'old_appliance', condition: 'pristine' }, // 3 格
      { id: 'old_appliance', condition: 'pristine' }, // 3 格
      { id: 'old_appliance', condition: 'pristine' }, // 超容量
    ]

    const { save, repairs } = parseSave(JSON.stringify(wire), config)
    expect(save.inventory.items).toHaveLength(2)
    expect(repairs.join('\n')).toContain('装不下')
  })

  it('盲盒被删除 → 丢弃对应保底计数，保留其他盒的计数', () => {
    const wire = cloneWire(createNewGame(config))
    wire.game.gacha.pityCounters = { junk_box: 7, atlantis: 3 }

    const { save, repairs } = parseSave(JSON.stringify(wire), config)
    expect(save.gacha.pityCounters).toEqual({ junk_box: 7 })
    expect(repairs.join('\n')).toContain('atlantis')
  })

  it('修复不影响其他字段，且多处修复会累积记录', () => {
    const wire = cloneWire(createNewGame(config))
    wire.game.player.vehicleId = 'spaceship'
    wire.game.player.stamina = 9999
    wire.game.player.money = 88

    const { save, repairs } = parseSave(JSON.stringify(wire), config)
    expect(repairs.length).toBeGreaterThanOrEqual(2)
    expect(save.player.money).toBe(88)
    expect(save.stats).toEqual({ trips: 0, earnedTotal: 0 })
  })
})

describe('save · 离线体力结算', () => {
  const staminaSave = (stamina: number): GameSave => {
    const base = createNewGame(config)
    return { ...base, player: { ...base.player, stamina } }
  }

  it('离线按恢复速率结算，并报出恢复量', () => {
    const save = staminaSave(0)
    const minutes = 30 // 未到满仓（config 的满仓时长为 120 分钟）
    const result = applyOfflineStamina(save, SAVED_AT, SAVED_AT + minutes * 60 * 1000, config)

    const expected = minutes * config.global.player.staminaRecoverPerMinute
    expect(result.save.player.stamina).toBeCloseTo(expected, 10)
    expect(result.recovered).toBeCloseTo(expected, 10)
  })

  it('离线满仓时长即可回满（当前 2 小时 → 上限 60）', () => {
    const save = staminaSave(0)
    const refillMinutes = config.global.player.maxStamina / config.global.player.staminaRecoverPerMinute
    const result = applyOfflineStamina(save, SAVED_AT, SAVED_AT + refillMinutes * 60 * 1000, config)

    expect(result.save.player.stamina).toBeCloseTo(config.global.player.maxStamina, 10)
  })

  it('超过封顶时长不再增加（离线最多 offlineStaminaCapHours 小时）', () => {
    const save = staminaSave(0)
    const capped = applyOfflineStamina(save, SAVED_AT, SAVED_AT + 10_000 * 60 * 1000, config)

    const { staminaRecoverPerMinute, offlineStaminaCapHours, maxStamina } = config.global.player
    const expected = Math.min(maxStamina, offlineStaminaCapHours * 60 * staminaRecoverPerMinute)
    expect(capped.save.player.stamina).toBeCloseTo(expected, 10)

    const exactly = applyOfflineStamina(save, SAVED_AT, SAVED_AT + offlineStaminaCapHours * 60 * 60 * 1000, config)
    expect(capped.save.player.stamina).toBeCloseTo(exactly.save.player.stamina, 10)
  })

  it('不超过体力上限（补到满就不再涨）', () => {
    const save = staminaSave(config.global.player.maxStamina - 10)
    const result = applyOfflineStamina(save, SAVED_AT, SAVED_AT + 4 * 60 * 60 * 1000, config)

    expect(result.save.player.stamina).toBe(config.global.player.maxStamina)
    expect(result.recovered).toBe(10)
  })

  it('离线封顶短于满仓时按封顶算（配置改动后仍然成立）', () => {
    const mutated = structuredClone(config) as unknown as {
      global: { player: { offlineStaminaCapHours: number } }
    }
    mutated.global.player.offlineStaminaCapHours = 1

    const save = staminaSave(0)
    const result = applyOfflineStamina(save, SAVED_AT, SAVED_AT + 10 * 60 * 60 * 1000, mutated as unknown as FrozenGameConfig)

    // 1 小时封顶 × 0.5 点/分钟 = 30 点
    expect(result.save.player.stamina).toBeCloseTo(30, 10)
  })

  it('满体力 / 时钟回拨 → 不恢复也不倒退，原存档对象不被修改', () => {
    const full = staminaSave(config.global.player.maxStamina)
    expect(applyOfflineStamina(full, SAVED_AT, SAVED_AT + 60 * 60 * 1000, config).recovered).toBe(0)
    expect(applyOfflineStamina(full, SAVED_AT, SAVED_AT + 60 * 60 * 1000, config).save).toBe(full)

    const rollback = staminaSave(10)
    const result = applyOfflineStamina(rollback, SAVED_AT, SAVED_AT - 60 * 60 * 1000, config)
    expect(result.recovered).toBe(0)
    expect(result.save.player.stamina).toBe(10)
    expect(rollback.player.stamina).toBe(10)
  })
})
