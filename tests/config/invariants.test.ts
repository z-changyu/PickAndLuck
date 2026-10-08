import { describe, expect, it } from 'vitest'

import { loadConfig } from '../../src/config/loader'
import {
  MAX_PER_STAMINA_GROWTH,
  MATERIAL_RETURN_RATE_MAX,
  MATERIAL_RETURN_RATE_MIN,
  RARITY_IDS,
  MIN_TRIPS_PER_STAMINA_BAR,
  RATE_TOLERANCE,
  SAVE_UP_TRIPS_MAX,
  SAVE_UP_TRIPS_MIN,
  STAMINA_REFILL_MINUTES_MAX,
  STAMINA_REFILL_MINUTES_MIN,
  availableItemsForZone,
  expectedReturnRateWithPity,
  staminaRefillMinutes,
  sumRates,
  zonePerStamina,
} from '../../src/config/schema'
import type { RarityId } from '../../src/config/schema'
import { at, cloneRaw, issuesOf } from './test-helpers'

const config = loadConfig()

const streetAvgValue = new Map<RarityId, number>(config.rarity.rarities.map((r) => [r.id, r.streetAvgValue]))
const materialValue = new Map<RarityId, number>(config.rarity.rarities.map((r) => [r.id, r.materialValue]))

describe('关键不变量 · 正向回归（当前 config 必须全部满足）', () => {
  it('不变量 1：每款盲盒的概率合计 = 100%', () => {
    for (const box of config.gacha.boxes) {
      expect(Math.abs(sumRates(box.rates) - 1), `${box.name} 概率合计`).toBeLessThanOrEqual(RATE_TOLERANCE)
    }
  })

  it('不变量 2：每款盲盒的材料返还率落在 0.55–0.65', () => {
    for (const box of config.gacha.boxes) {
      const expectedValue = RARITY_IDS.reduce((acc, id) => acc + box.rates[id] * (materialValue.get(id) ?? 0), 0)
      const returnRate = expectedValue / box.price

      expect(returnRate, `${box.name} 返还率`).toBeGreaterThanOrEqual(MATERIAL_RETURN_RATE_MIN)
      expect(returnRate, `${box.name} 返还率`).toBeLessThanOrEqual(MATERIAL_RETURN_RATE_MAX)
    }
  })

  it('不变量 3 / 4：保底与新手保护的配置到位', () => {
    expect(config.gacha.pity.targetRarity).toBe('purple')
    expect(config.gacha.pity.scope).toBe('per_box')
    expect(config.gacha.pity.resetOnHit).toBe(true)
    expect(config.gacha.pity.newPlayerFirstPullMinRarity).toBe('blue')

    // 每盒都显式给出保底计数（null = 该盒不设保底）
    for (const box of config.gacha.boxes) {
      expect(box.pityCounter === null || box.pityCounter >= 2, box.name).toBe(true)
    }
  })

  it('不变量 5：各区域概率合计 = 1，且每体力收益随区域递增、增幅 ≤ 10%', () => {
    for (const zone of config.zones.zones) {
      expect(Math.abs(sumRates(zone.dropRates) - 1), `${zone.name} 概率合计`).toBeLessThanOrEqual(RATE_TOLERANCE)
    }

    const zones = [...config.zones.zones].sort((a, b) => a.unlockLevel - b.unlockLevel)
    for (let i = 1; i < zones.length; i += 1) {
      const prev = at(zones, i - 1, 'zones')
      const curr = at(zones, i, 'zones')
      const prevValue = zonePerStamina(prev, streetAvgValue)
      const currValue = zonePerStamina(curr, streetAvgValue)

      expect(currValue, `${curr.name} 每体力收益`).toBeGreaterThan(prevValue)
      expect(currValue / prevValue - 1, `${curr.name} 增幅`).toBeLessThanOrEqual(MAX_PER_STAMINA_GROWTH)
    }
  })

  it('不变量 6：载具升级的攒钱趟数落在 8–18 趟', () => {
    for (const checkpoint of config.vehicles.upgradeCheckpoints) {
      const saveUpTrips = checkpoint.saveUpTrips
      expect(saveUpTrips, `${checkpoint.to} 攒钱趟数`).toBeDefined()
      if (saveUpTrips === undefined) continue
      expect(saveUpTrips).toBeGreaterThanOrEqual(SAVE_UP_TRIPS_MIN)
      expect(saveUpTrips).toBeLessThanOrEqual(SAVE_UP_TRIPS_MAX)
    }
  })
})

describe('关键不变量 · 负例（改坏必须被拦住）', () => {
  it('盲盒售价被改高，返还率跌破 0.55 → 拦截并点名盲盒', () => {
    const raw = cloneRaw()
    at(raw.gacha.boxes, 3, 'boxes').price = 200 // 记忆盲盒 EV 50 → 返还率 0.25

    const text = issuesOf(raw).join('\n')
    expect(text).toContain('记忆盲盒')
    expect(text).toContain('健康区间')
  })

  it('载具升级成本暴涨，攒钱趟数超出 8–18 → 拦截并点名载具', () => {
    const raw = cloneRaw()
    at(raw.vehicles.vehicles, 1, 'vehicles').upgradeCostFromPrev = 10_000 // 10000 ÷ 9 ≈ 1111 趟

    const text = issuesOf(raw).join('\n')
    expect(text).toContain('小推车')
    expect(text).toContain('攒钱趟数')
  })

  it('区域体力成本被压到过低，每体力收益增幅超过 10% → 拦截并点名区域', () => {
    const raw = cloneRaw()
    at(raw.zones.zones, 4, 'zones').staminaCost = 12 // 老城区：每体力收益从 2.24 涨到 5.6

    const text = issuesOf(raw).join('\n')
    expect(text).toContain('老城区')
    expect(text).toContain('关键不变量 5')
  })

  it('盲盒概率被改坏导致派生值不自洽 → 拦截', () => {
    const raw = cloneRaw()
    at(raw.gacha.boxes, 2, 'boxes').rates.purple = 0.4 // 古董盲盒：合计与 EV 都会对不上

    const text = issuesOf(raw).join('\n')
    expect(text).toContain('古董盲盒')
    expect(text).toContain('rates')
  })
})

describe('不变量 7 · 每个区域 × 每个档位都必须有可拾取物品', () => {
  it('当前 config 全区域全档位都有货（补录 6 件后成立）', () => {
    for (const zone of config.zones.zones) {
      for (const rarity of RARITY_IDS) {
        const usable = availableItemsForZone(config.items.items, zone.id, rarity)
        expect(usable.length, `${zone.name}(${zone.id}) 的 ${rarity} 档可用物品数`).toBeGreaterThan(0)
      }
    }
  })

  it('街头物品共 21 件（原 15 件 + 补录 6 件）', () => {
    expect(config.items.items).toHaveLength(21)
  })

  it('负例：把补录的绿档物品挪出街头巷尾 → 点名区域与档位', () => {
    const raw = cloneRaw()
    const basket = raw.items.items.find((item) => item.id === 'rattan_basket')
    expect(basket).toBeDefined()
    if (basket === undefined) return
    basket.zones = ['shopping_street'] // 街头巷尾/老城区/填埋场的绿档随即空档

    const text = issuesOf(raw).join('\n')
    expect(text).toContain('街头巷尾')
    expect(text).toContain('green')
    expect(text).toContain('没有任何可用物品')
  })
})

describe('不变量 8 · 品相出现权重', () => {
  it('权重合计 = 1，且与品相系数的键一一对应', () => {
    const { conditionWeights, conditionMultiplier } = config.global.sell
    const sum = conditionWeights.pristine + conditionWeights.worn + conditionWeights.broken

    expect(Math.abs(sum - 1)).toBeLessThanOrEqual(RATE_TOLERANCE)
    expect(Object.keys(conditionWeights).sort()).toEqual(Object.keys(conditionMultiplier).sort())
  })

  it('负例：权重之和改成 1.05 → 拦截并点名 conditionWeights', () => {
    const raw = cloneRaw()
    raw.global.sell.conditionWeights.worn = 0.4

    const text = issuesOf(raw).join('\n')
    expect(text).toContain('conditionWeights')
    expect(text).toContain('必须等于 1')
  })
})

describe('新增不变量 · 含保底的返还率（逐盒保底不能变成提款机）', () => {
  it('当前配置：每款盲盒含保底返还率都在 55%–65%', () => {
    const materialValue = new Map<RarityId, number>(
      config.rarity.rarities.map((rarity) => [rarity.id, rarity.materialValue]),
    )

    for (const box of config.gacha.boxes) {
      const withPity = expectedReturnRateWithPity(box, materialValue, config.gacha.pity.targetRarity)
      expect(withPity, `${box.name}`).toBeGreaterThanOrEqual(MATERIAL_RETURN_RATE_MIN)
      expect(withPity, `${box.name}`).toBeLessThanOrEqual(MATERIAL_RETURN_RATE_MAX)
    }
  })

  it('负例：废品盲盒保底计数退回 10 → 含保底返还率爆表，点名盲盒与保底计数', () => {
    const raw = cloneRaw()
    at(raw.gacha.boxes, 0, 'boxes').pityCounter = 10

    const text = issuesOf(raw).join('\n')
    expect(text).toContain('废品盲盒')
    expect(text).toContain('pityCounter=10')
    expect(text).toContain('只买保底刷钱')
  })

  it('负例：含保底返还率派生值与解析解不符 → 拦截', () => {
    const raw = cloneRaw()
    at(raw.gacha.boxes, 0, 'boxes').returnRateWithPity = 0.9

    const text = issuesOf(raw).join('\n')
    expect(text).toContain('returnRateWithPity')
    expect(text).toContain('解析解')
  })

  it('负例：保底目标档的概率合计为 0 → 说明保底无法执行', () => {
    const raw = cloneRaw()
    const box = at(raw.gacha.boxes, 0, 'boxes')
    box.rates.purple = 0
    box.rates.gold = 0
    box.rates.white = 0.67
    box.pityCounter = 50

    const text = issuesOf(raw).join('\n')
    expect(text).toContain('保底无法执行')
  })
})

describe('新增不变量 · 体力（满仓时长与新手可玩性）', () => {
  it('当前配置：满仓时长 90–240 分钟、离线封顶不短于满仓、满仓够跑 ≥3 趟默认区域', () => {
    const player = config.global.player
    const refill = staminaRefillMinutes(player)

    expect(refill).toBeGreaterThanOrEqual(STAMINA_REFILL_MINUTES_MIN)
    expect(refill).toBeLessThanOrEqual(STAMINA_REFILL_MINUTES_MAX)
    expect(player.offlineStaminaCapHours * 60).toBeGreaterThanOrEqual(refill)

    const startZone = [...config.zones.zones].sort((a, b) => a.unlockLevel - b.unlockLevel)[0]
    expect(startZone).toBeDefined()
    if (startZone !== undefined) {
      expect(player.maxStamina / startZone.staminaCost).toBeGreaterThanOrEqual(MIN_TRIPS_PER_STAMINA_BAR)
    }
  })

  it('负例：恢复速率退回 0.125（满仓 8 小时）→ 拦截并给出可玩区间', () => {
    const raw = cloneRaw()
    raw.global.player.staminaRecoverPerMinute = 0.125

    const text = issuesOf(raw).join('\n')
    expect(text).toContain('480 分钟')
    expect(text).toContain('可玩区间')
  })

  it('负例：恢复速率过高（满仓 30 分钟）→ 拦截', () => {
    const raw = cloneRaw()
    raw.global.player.staminaRecoverPerMinute = 2

    const text = issuesOf(raw).join('\n')
    expect(text).toContain('30 分钟')
    expect(text).toContain('形同取消')
  })

  it('负例：默认区域单趟体力过大（满仓跑不到 3 趟）→ 拦截', () => {
    const raw = cloneRaw()
    at(raw.zones.zones, 0, 'zones').staminaCost = 30

    expect(issuesOf(raw).join('\n')).toContain('体力卡死')
  })

  it('负例：离线封顶短于满仓时长 → 拦截', () => {
    const raw = cloneRaw()
    raw.global.player.offlineStaminaCapHours = 1

    expect(issuesOf(raw).join('\n')).toContain('睡一觉回来仍然没回满')
  })
})

describe('不变量 9 / 10 · 等级曲线与假点率', () => {
  it('等级曲线首项为 0、严格递增、覆盖所有 unlockLevel', () => {
    const curve = config.global.level.cumulativeExp

    expect(curve[0]).toBe(0)
    for (let i = 1; i < curve.length; i += 1) {
      expect(at(curve, i, 'cumulativeExp'), `Lv${i + 1}`).toBeGreaterThan(at(curve, i - 1, 'cumulativeExp'))
    }

    const maxUnlockLevel = Math.max(...config.zones.zones.map((zone) => zone.unlockLevel))
    expect(curve.length).toBeGreaterThanOrEqual(maxUnlockLevel)
  })

  it('每个区域的假点率都落在 [0, 1)', () => {
    for (const zone of config.zones.zones) {
      expect(zone.emptyPointRate, `${zone.name} 假点率`).toBeGreaterThanOrEqual(0)
      expect(zone.emptyPointRate, `${zone.name} 假点率`).toBeLessThan(1)
    }
  })

  it('负例：等级曲线被截断到 Lv3 → 点名未覆盖的区域', () => {
    const raw = cloneRaw()
    raw.global.level.cumulativeExp = [0, 20, 50]

    const text = issuesOf(raw).join('\n')
    expect(text).toContain('覆盖到 Lv3')
    expect(text).toContain('城郊填埋场')
  })

  it('负例：等级曲线首项不是 0 → 拦截', () => {
    const raw = cloneRaw()
    raw.global.level.cumulativeExp[0] = 5

    expect(issuesOf(raw).join('\n')).toContain('首项必须为 0')
  })

  it('负例：等级曲线出现相等值 → 拦截并点名等级', () => {
    const raw = cloneRaw()
    const curve = raw.global.level.cumulativeExp
    curve[5] = at(curve, 4, 'cumulativeExp')

    const text = issuesOf(raw).join('\n')
    expect(text).toContain('必须严格递增')
    expect(text).toContain('Lv6')
  })

  it('负例：假点率 = 1 → 拦截并点名区域', () => {
    const raw = cloneRaw()
    at(raw.zones.zones, 5, 'zones').emptyPointRate = 1

    const text = issuesOf(raw).join('\n')
    expect(text).toContain('城郊填埋场')
    expect(text).toContain('emptyPointRate')
  })
})
