import { describe, expect, it } from 'vitest'

import { loadConfig } from '../../src/config/loader'
import {
  conditionMultiplierOf,
  expFromSales,
  sellTotal,
  sellUnitPrice,
  totalGrids,
  totalWeightKg,
  zonePriceModifierOf,
} from '../../src/core/economy'
import type { PickedItem } from '../../src/core/pickup'

const config = loadConfig()

const itemOf = (id: string) => {
  const item = config.items.items.find((candidate) => candidate.id === id)
  if (item === undefined) throw new Error(`测试数据缺少物品 ${id}`)
  return item
}

const picked = (id: string, condition: PickedItem['condition'] = 'pristine'): PickedItem => ({
  item: itemOf(id),
  condition,
})

describe('economy · 售价公式（验收：Σ(单价 × 品相系数 × 区域价格系数)）', () => {
  it('系数全部来自 config', () => {
    expect(conditionMultiplierOf('pristine', config)).toBe(1.0)
    expect(conditionMultiplierOf('worn', config)).toBe(0.8)
    expect(conditionMultiplierOf('broken', config)).toBe(0.5)
    expect(zonePriceModifierOf('street_alley', config)).toBe(1.0)
    expect(zonePriceModifierOf('old_town', config)).toBe(1.25)
  })

  it('单件售价 = 单价 × 品相系数 × 区域价格系数', () => {
    // 塑料瓶 0.05 元 · 完好(×1.0) · 街头巷尾(×1.0)
    expect(sellUnitPrice(picked('plastic_bottle'), 'street_alley', config)).toBeCloseTo(0.05, 10)
    // 塑料瓶 0.05 元 · 磨损(×0.8) · 商业街区(×0.85) → 0.034
    expect(sellUnitPrice(picked('plastic_bottle', 'worn'), 'shopping_street', config)).toBeCloseTo(0.034, 10)
    // 名家字画 1200 元 · 完好 · 老城区(×1.25) → 1500
    expect(sellUnitPrice(picked('masterpiece'), 'old_town', config)).toBeCloseTo(1500, 10)
  })

  it('整趟结算 = 逐件相加；破损打对折', () => {
    // 0.05×1.0×1.0 + 15×0.5×1.0 = 7.55
    expect(sellTotal([picked('plastic_bottle'), picked('old_phone', 'broken')], 'street_alley', config)).toBeCloseTo(
      7.55,
      10,
    )
    expect(sellTotal([], 'street_alley', config)).toBe(0)
  })

  it('区域价格系数形成「跑商」差价（0.85 ↔ 1.25）', () => {
    const cheap = sellUnitPrice(picked('old_phone'), 'shopping_street', config)
    const rich = sellUnitPrice(picked('old_phone'), 'old_town', config)
    expect(rich).toBeGreaterThan(cheap)
    expect(rich / cheap).toBeCloseTo(1.25 / 0.85, 6)
  })

  it('经验 = 出售额 × expPerCurrency', () => {
    expect(expFromSales(9, config)).toBeCloseTo(config.global.level.expPerCurrency * 9, 10)
    expect(expFromSales(0, config)).toBe(0)
  })

  it('占格与重量逐件累加', () => {
    const items = [picked('old_appliance'), picked('tire')] // 3 格 + 2 格；3.5kg + 6kg
    expect(totalGrids(items)).toBe(5)
    expect(totalWeightKg(items)).toBeCloseTo(9.5, 10)
  })

  it('未知区域直接抛错（不静默返回 0 元）', () => {
    expect(() => zonePriceModifierOf('atlantis', config)).toThrow(/atlantis/)
    expect(() => sellUnitPrice(picked('plastic_bottle'), 'atlantis', config)).toThrow()
  })
})
