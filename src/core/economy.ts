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

// ---------------------------------------------------------------- 结算单（T6）

/** 结算单上的一行：每个数字都来自配置或上面的公式，界面直接展示即可 */
export interface SettlementLine {
  readonly picked: PickedItem
  /** 回收单价（items.json） */
  readonly unitPrice: number
  /** 品相系数（global.sell.conditionMultiplier） */
  readonly conditionMultiplier: number
  /** 区域价格系数（global.sell.zonePriceModifier） */
  readonly zoneModifier: number
  /** 逐件售价 = 单价 × 品相系数 × 区域系数（不取整） */
  readonly amount: number
  /** 逐件重量（kg），称重动画要逐件累加 */
  readonly weightKg: number
}

export interface Settlement {
  readonly zoneId: string
  readonly lines: readonly SettlementLine[]
  readonly itemCount: number
  readonly totalGrids: number
  readonly totalWeightKg: number
  /** 精确合计（不取整，逐件相加） */
  readonly gross: number
  /** 本次结算获得的经验（按合计金额折算） */
  readonly expGained: number
}

/**
 * 一趟的结算单 —— 全工程唯一的「结算」口径。
 *
 * T6 验收「界面显示金额与 core 出数完全一致」靠的就是这条：界面只许展示本函数的字段，
 * 不许自己再乘一遍（否则迟早出现「秤上 8.8、明细加起来 8.9」这种对不上账）。
 *
 * 精度规则：**全程不取整**。货币在内部是精确浮点，显示层统一保留两位小数（ui/format.ts）。
 * 若逐件取整，白档 1.0×0.8×0.85 = 0.68 会被抹成 0；若整趟取整，捡 6 个塑料瓶的一趟会变成 0 元
 * —— 两种取整都会让白档直接失去意义，所以取整这件事只发生在显示层。
 */
export function settleBag(picked: readonly PickedItem[], zoneId: string, config: FrozenGameConfig): Settlement {
  const lines: SettlementLine[] = picked.map((item) => ({
    picked: item,
    unitPrice: item.item.unitPrice,
    conditionMultiplier: conditionMultiplierOf(item.condition, config),
    zoneModifier: zonePriceModifierOf(zoneId, config),
    amount: sellUnitPrice(item, zoneId, config),
    weightKg: item.item.weightKg,
  }))

  const gross = lines.reduce((total, line) => total + line.amount, 0)

  return {
    zoneId,
    lines,
    itemCount: lines.length,
    totalGrids: totalGrids(picked),
    totalWeightKg: totalWeightKg(picked),
    gross,
    expGained: expFromSales(gross, config),
  }
}
