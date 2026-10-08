import { describe, expect, it } from 'vitest'

import { loadConfig } from '../../src/config/loader'
import {
  canFit,
  capacityOf,
  clearInventory,
  createInventory,
  expandInventory,
  inventoryWeightKg,
  remainingGrids,
  tryAdd,
  usedGrids,
} from '../../src/core/inventory'
import type { Inventory } from '../../src/core/inventory'
import type { PickedItem } from '../../src/core/pickup'

const config = loadConfig()

const itemOf = (id: string) => {
  const item = config.items.items.find((candidate) => candidate.id === id)
  if (item === undefined) throw new Error(`测试数据缺少物品 ${id}`)
  return item
}

const picked = (id: string): PickedItem => ({ item: itemOf(id), condition: 'pristine' })

/** 装一件，失败直接让用例炸掉（避免在用例里写非空断言） */
const addOrFail = (inventory: Inventory, id: string): Inventory => {
  const result = tryAdd(inventory, picked(id))
  if (!result.ok) throw new Error(`预期能装下 ${id}，实际被拒：${result.reason}`)
  return result.inventory
}

describe('inventory · 容量来自载具与扩容', () => {
  it('手提袋 6 格；每次扩容 +2 格', () => {
    expect(capacityOf('tote_bag', 0, config)).toBe(6)
    expect(capacityOf('tote_bag', 1, config)).toBe(8)
    expect(capacityOf('handcart', 0, config)).toBe(12)
    expect(capacityOf('handcart', 3, config)).toBe(18)
  })

  it('未知载具抛错', () => {
    expect(() => capacityOf('spaceship', 0, config)).toThrow(/spaceship/)
  })
})

describe('inventory · 装包与取舍（验收：背包满时无法拾取多格物品）', () => {
  it('剩 2 格时装不下占 3 格的旧家电，且背包不被改动', () => {
    const inventory = createInventory(2)
    expect(canFit(inventory, picked('old_appliance'))).toBe(false)

    const result = tryAdd(inventory, picked('old_appliance'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('not_enough_grids')
    expect(usedGrids(inventory)).toBe(0)
  })

  it('装得下时追加，占格与剩余格同步变化', () => {
    let inventory = createInventory(6)
    inventory = addOrFail(inventory, 'plastic_bottle') // 1 格
    inventory = addOrFail(inventory, 'old_appliance') // 3 格

    expect(inventory.items).toHaveLength(2)
    expect(usedGrids(inventory)).toBe(4)
    expect(remainingGrids(inventory)).toBe(2)
  })

  it('一格不剩后再装 1 格物品会被拒', () => {
    let inventory = createInventory(2)
    inventory = addOrFail(inventory, 'plastic_bottle')
    inventory = addOrFail(inventory, 'can')

    expect(remainingGrids(inventory)).toBe(0)
    expect(tryAdd(inventory, picked('can')).ok).toBe(false)
  })

  it('操作不可变：原背包不被修改', () => {
    const base = createInventory(6)
    const result = tryAdd(base, picked('plastic_bottle'))

    expect(base.items).toHaveLength(0)
    if (result.ok) expect(result.inventory.items).toHaveLength(1)
  })

  it('扩容加格数、清空保留容量', () => {
    const base = createInventory(6)
    expect(expandInventory(base, 2).capacity).toBe(8)
    expect(() => expandInventory(base, 0)).toThrow()
    expect(() => createInventory(-1)).toThrow()

    const filled = addOrFail(base, 'can')
    const cleared = clearInventory(filled)
    expect(cleared.items).toHaveLength(0)
    expect(cleared.capacity).toBe(6)
  })

  it('重量按物品累加（废旧轮胎 6kg）', () => {
    expect(inventoryWeightKg(addOrFail(createInventory(6), 'tire'))).toBeCloseTo(6, 10)
  })
})
