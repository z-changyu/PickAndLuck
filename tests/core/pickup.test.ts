import { describe, expect, it } from 'vitest'

import { loadConfig } from '../../src/config/loader'
import { RARITY_IDS } from '../../src/config/schema'
import { rollCondition, rollPickup, rollRarity } from '../../src/core/pickup'
import { createRng } from '../../src/core/rng'

const config = loadConfig()

/** 固定 seed → 完全确定的序列，因此下面所有采样都是可复现的 */
const SAMPLE_SEED = 20261008

describe('pickup · 可复现（同一 seed 必须逐件一致）', () => {
  const run = (seed: number) => {
    const rng = createRng(seed)
    return Array.from({ length: 200 }, () => rollPickup(rng, config, 'old_town'))
  }

  it('同一 seed 两次采样逐件相同', () => {
    expect(run(SAMPLE_SEED)).toEqual(run(SAMPLE_SEED))
  })

  it('不同 seed 给出不同序列', () => {
    expect(run(1)).not.toEqual(run(2))
  })
})

describe('pickup · 永不空档（补录 6 件物品后的核心保证）', () => {
  it('6 个区域各抽 2000 次都不抛错，且物品一定属于该区域', () => {
    for (const zone of config.zones.zones) {
      const rng = createRng(1000 + zone.unlockLevel)
      for (let i = 0; i < 2000; i += 1) {
        const roll = rollPickup(rng, config, zone.id)
        if (roll.kind !== 'item') continue
        const { zones, id } = roll.picked.item
        expect(zones.includes('all') || zones.includes(zone.id), `${zone.id} 抽到不该出现的 ${id}`).toBe(true)
      }
    }
  })

  it('配置被绕开时（某档位无物品）会明确抛错，而不是静默返回空档', () => {
    const broken = structuredClone(config) as unknown as {
      items: { items: Array<{ rarity: string; zones: string[] }> }
    }
    for (const item of broken.items.items) if (item.rarity === 'gold') item.zones = ['atlantis']

    const rng = createRng(1)
    let thrown = false
    for (let i = 0; i < 5000 && !thrown; i += 1) {
      try {
        rollPickup(rng, broken as unknown as typeof config, 'old_town')
      } catch {
        thrown = true
      }
    }
    expect(thrown).toBe(true)
  })
})

describe('pickup · 分布与配置一致（T5 验收口径）', () => {
  it('非假点结果的稀有度分布 ≈ 区域 dropRates', () => {
    const zone = config.zones.zones[0]
    expect(zone).toBeDefined()
    if (zone === undefined) return

    const rng = createRng(SAMPLE_SEED)
    const samples = 30000
    const counts = new Map<string, number>()
    let itemCount = 0

    for (let i = 0; i < samples; i += 1) {
      const roll = rollPickup(rng, config, zone.id)
      if (roll.kind !== 'item') continue
      itemCount += 1
      const rarity = roll.picked.item.rarity
      counts.set(rarity, (counts.get(rarity) ?? 0) + 1)
    }

    expect(itemCount).toBeGreaterThan(0)
    for (const rarity of RARITY_IDS) {
      const observed = (counts.get(rarity) ?? 0) / itemCount
      const expected = zone.dropRates[rarity]
      expect(Math.abs(observed - expected), `${rarity} 观测 ${observed.toFixed(4)} 期望 ${expected}`).toBeLessThan(
        0.015,
      )
    }
  })

  it('假点比例 ≈ 各区域 emptyPointRate', () => {
    for (const zone of config.zones.zones) {
      const rng = createRng(777 + zone.unlockLevel)
      const samples = 20000
      let empty = 0
      for (let i = 0; i < samples; i += 1) if (rollPickup(rng, config, zone.id).kind === 'empty') empty += 1

      const observed = empty / samples
      expect(Math.abs(observed - zone.emptyPointRate), `${zone.name} 假点率 ${observed.toFixed(4)}`).toBeLessThan(0.015)
    }
  })

  it('品相分布 ≈ conditionWeights', () => {
    const rng = createRng(31337)
    const samples = 30000
    const counts = new Map<string, number>()
    for (let i = 0; i < samples; i += 1) {
      const condition = rollCondition(rng, config)
      counts.set(condition, (counts.get(condition) ?? 0) + 1)
    }

    const weights = config.global.sell.conditionWeights
    for (const condition of ['pristine', 'worn', 'broken'] as const) {
      const observed = (counts.get(condition) ?? 0) / samples
      expect(Math.abs(observed - weights[condition]), `${condition} ${observed.toFixed(4)}`).toBeLessThan(0.015)
    }
  })

  it('rollRarity 只返回该区域概率非零的档位', () => {
    for (const zone of config.zones.zones) {
      const rng = createRng(9)
      const seen = new Set<string>()
      for (let i = 0; i < 2000; i += 1) seen.add(rollRarity(rng, config, zone.id))

      for (const rarity of seen) {
        expect(RARITY_IDS).toContain(rarity)
        expect(zone.dropRates[rarity as (typeof RARITY_IDS)[number]], `${zone.id} 的 ${rarity}`).toBeGreaterThan(0)
      }
    }
  })

  it('未知区域抛错', () => {
    expect(() => rollRarity(createRng(1), config, 'atlantis')).toThrow(/atlantis/)
    expect(() => rollPickup(createRng(1), config, 'atlantis')).toThrow(/atlantis/)
  })
})
