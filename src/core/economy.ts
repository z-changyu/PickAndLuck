import type { FrozenGameConfig } from '../config/loader'
import { findZone } from '../config/schema'
import type { ConditionId } from '../config/schema'
import type { PickedItem } from './pickup'

/**
 * 出售结算 —— 全工程唯一的「售价」公式实现。
 *
 * T6 垃圾场界面必须直接调用这里，不允许前端另算一遍
 * （否则「界面显示金额与 core 计算一致」这条验收标准不可能长期成立）。
 *
 *   售价 = 回收单价 × 品相系数 × 区域价格系数
 *     回收单价      items.json  → unitPrice
 *     品相系数      global.json → sell.conditionMultiplier
 *     区域价格系数  global.json → sell.zonePriceModifier（0.85–1.25，即「跑商」空间）
 */

export const conditionMultiplierOf = (condition: ConditionId, config: FrozenGameConfig): number =>
  config.global.sell.conditionMultiplier[condition]

export function zonePriceModifierOf(zoneId: string, config: FrozenGameConfig): number {
  const zone = findZone(config.zones.zones, zoneId)
  const modifier = config.global.sell.zonePriceModifier[zone.id]
  if (modifier === undefined) {
    throw new Error(
      `区域「${zone.name}」(${zone.id}) 缺少价格系数：global.sell.zonePriceModifier（check-config 本应拦住）`,
    )
  }
  return modifier
}

/** 单件售价 */
export function sellUnitPrice(picked: PickedItem, zoneId: string, config: FrozenGameConfig): number {
  return picked.item.unitPrice * conditionMultiplierOf(picked.condition, config) * zonePriceModifierOf(zoneId, config)
}

/** 整趟结算总额（保留原始精度，四舍五入交给展示层） */
export function sellTotal(picked: readonly PickedItem[], zoneId: string, config: FrozenGameConfig): number {
  return picked.reduce((total, item) => total + sellUnitPrice(item, zoneId, config), 0)
}

/** 出售额折算经验：1 元 = expPerCurrency 点（global.json → level） */
export const expFromSales = (money: number, config: FrozenGameConfig): number =>
  money * config.global.level.expPerCurrency

/** 整趟占格数 */
export const totalGrids = (picked: readonly PickedItem[]): number =>
  picked.reduce((total, item) => total + item.item.gridCost, 0)

/** 整趟重量（kg） */
export const totalWeightKg = (picked: readonly PickedItem[]): number =>
  picked.reduce((total, item) => total + item.item.weightKg, 0)
