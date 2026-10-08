import { describe, expect, it } from 'vitest'

import { loadConfig } from '../../src/config/loader'
import { RARITY_IDS } from '../../src/config/schema'
import type { RarityId } from '../../src/config/schema'
import { createInventory, remainingGrids } from '../../src/core/inventory'
import { createRng } from '../../src/core/rng'
import { pickAt, startTrip, tripItemCount, tripRarityTotal } from '../../src/core/trip'
import type { PickOutcome, TripState } from '../../src/core/trip'

const config = loadConfig()
const ZONE = 'street_alley'

const newTrip = (capacity = 6): TripState => startTrip(config, ZONE, createInventory(capacity))

/** 反复点到出现某个结果为止，并返回这一次的前后状态（避免用例里写非空断言） */
const pickUntil = (
  rng: ReturnType<typeof createRng>,
  trip: TripState,
  kind: 'empty' | 'picked' | 'full',
): { before: TripState; after: TripState; outcome: PickOutcome } => {
  for (let i = 0; i < 500; i += 1) {
    const result = pickAt(rng, config, trip)
    if (result.outcome.kind === kind) return { before: trip, after: result.trip, outcome: result.outcome }
    trip = result.trip
  }
  throw new Error(`500 次都没点出 ${kind}`)
}

describe('trip · 开始一趟', () => {
  it('初始状态干净：没点过、背包为空、五档计数全 0', () => {
    const trip = newTrip()

    expect(trip.zoneId).toBe(ZONE)
    expect(trip.taps).toBe(0)
    expect(trip.emptyTaps).toBe(0)
    expect(tripItemCount(trip)).toBe(0)
    expect(trip.rarityCounts).toEqual({ white: 0, green: 0, blue: 0, purple: 0, gold: 0 })
  })

  it('未知区域直接抛错', () => {
    expect(() => startTrip(config, 'atlantis', createInventory(6))).toThrow(/atlantis/)
  })
})

describe('trip · 点一次垃圾点', () => {
  it('假点：只涨 taps 与 emptyTaps，背包与产出统计都不变', () => {
    const { before, after, outcome } = pickUntil(createRng(20261008), newTrip(), 'empty')

    expect(outcome.kind).toBe('empty')
    expect(after.taps).toBe(before.taps + 1)
    expect(after.emptyTaps).toBe(before.emptyTaps + 1)
    expect(after.inventory.items).toHaveLength(before.inventory.items.length)
    expect(after.rarityCounts).toEqual(before.rarityCounts)
  })

  it('捡到东西：进背包、对应档位 +1、taps +1', () => {
    const { before, after, outcome } = pickUntil(createRng(20261008), newTrip(), 'picked')

    expect(outcome.kind).toBe('picked')
    if (outcome.kind !== 'picked') return

    const rarity = outcome.picked.item.rarity
    expect(after.inventory.items).toHaveLength(before.inventory.items.length + 1)
    expect(after.taps).toBe(before.taps + 1)
    expect(after.rarityCounts[rarity]).toBe((before.rarityCounts[rarity] ?? 0) + 1)
    expect(tripRarityTotal(after)).toBe(before.inventory.items.length + 1)
  })

  it('装不下：物品留在原地（不进包、不计入产出），背包与计数都不变', () => {
    // 只留 1 格：抽到占 2 格以上的物品就会 full（高稀有度才有大件，多抽几次必然遇到）
    const rng = createRng(4242)
    let trip = newTrip(1)

    for (let i = 0; i < 200; i += 1) {
      const result = pickAt(rng, config, trip)
      trip = result.trip
      if (result.outcome.kind === 'full') {
        expect(remainingGrids(trip.inventory)).toBe(1)
        expect(result.outcome.picked.item.gridCost).toBeGreaterThan(1)
        expect(trip.inventory.items).toHaveLength(0)
        expect(tripRarityTotal(trip)).toBe(0)
        return
      }
      // 1 格物品会被装进去，装满了就换一趟继续试
      if (remainingGrids(trip.inventory) === 0) trip = newTrip(1)
    }
    throw new Error('200 次都没遇到装不下的情况')
  })

  it('不可变：原 trip 不被修改', () => {
    const trip = newTrip()
    const snapshot = JSON.stringify(trip.rarityCounts)

    pickAt(createRng(7), config, trip)

    expect(trip.taps).toBe(0)
    expect(trip.inventory.items).toHaveLength(0)
    expect(JSON.stringify(trip.rarityCounts)).toBe(snapshot)
  })
})

describe('trip · 产出分布（T5 验收：与区域 dropRates 对比）', () => {
  it(
    '1000 次以上的实际产出分布 ≈ 区域 dropRates（容差 0.015）',
    () => {
      // 用超大背包，避免中途装满导致 full 干扰统计
      const rng = createRng(20261008)
      let trip = startTrip(config, ZONE, createInventory(50_000))
      const samples = 10000

      for (let i = 0; i < samples; i += 1) trip = pickAt(rng, config, trip).trip

      const zone = config.zones.zones.find((candidate) => candidate.id === ZONE)
      expect(zone).toBeDefined()
      if (zone === undefined) return

      const picked = tripRarityTotal(trip)
      expect(picked).toBeGreaterThan(1000)

      for (const rarity of RARITY_IDS) {
        const observed = (trip.rarityCounts[rarity as RarityId] ?? 0) / picked
        const expected = zone.dropRates[rarity]
        expect(Math.abs(observed - expected), `${rarity} 观测 ${observed.toFixed(4)} 期望 ${expected}`).toBeLessThan(
          0.015,
        )
      }

      // 假点比例也要对得上配置
      expect(Math.abs(trip.emptyTaps / trip.taps - zone.emptyPointRate), ZONE).toBeLessThan(0.015)
    },
    15_000,
  )

  it('各档计数之和 = 背包里的件数（统计口径一致）', () => {
    const rng = createRng(99)
    let trip = newTrip(50)
    for (let i = 0; i < 200; i += 1) trip = pickAt(rng, config, trip).trip

    expect(tripRarityTotal(trip)).toBe(tripItemCount(trip))
    expect(trip.taps).toBeGreaterThanOrEqual(tripItemCount(trip))
  })
})
