import type { FrozenGameConfig } from '../config/loader'
import { CONDITION_IDS, RARITY_IDS, availableItemsForZone, findZone } from '../config/schema'
import type { ConditionId, RarityId } from '../config/schema'
import type { Rng } from './rng'

/**
 * 拾取判定：假点 → 稀有度 → 具体品类 → 品相。
 *
 * 这是「区域 dropRates 的声明值」与「实际捡到的东西」之间唯一的换算处：
 *   · 稀有度严格按 zones.json 的 dropRates（不变量 7 保证每个非零档位都有货，因此永不空档）
 *   · 具体品类在该区域该档位的可用物品里等概率抽（见 config/schema.ts → availableItemsForZone）
 *   · 品相按 global.sell.conditionWeights
 */

/** 拾取物只依赖物品的这几个字段；写成结构类型是为了兼容被冻结的配置对象 */
export interface PickupLike {
  readonly id: string
  readonly name: string
  readonly rarity: RarityId
  readonly zones: readonly string[]
  readonly weightKg: number
  readonly unitPrice: number
  readonly gridCost: number
}

/** 一件已拾取的东西：物品 + 品相 */
export interface PickedItem {
  readonly item: PickupLike
  readonly condition: ConditionId
}

/** 一次拾取判定的结果；empty = 踩到假点（已空的垃圾点） */
export type PickupRoll = { readonly kind: 'empty' } | { readonly kind: 'item'; readonly picked: PickedItem }

/** 稀有度 roll：严格按区域 dropRates */
export function rollRarity(rng: Rng, config: FrozenGameConfig, zoneId: string): RarityId {
  const zone = findZone(config.zones.zones, zoneId)
  const index = rng.weightedIndex(RARITY_IDS.map((rarity) => zone.dropRates[rarity]))
  const rarity = RARITY_IDS[index]
  if (rarity === undefined) throw new Error(`rollRarity: 权重下标 ${index} 越界`)
  return rarity
}

/** 品相 roll：按 global.sell.conditionWeights */
export function rollCondition(rng: Rng, config: FrozenGameConfig): ConditionId {
  const weights = config.global.sell.conditionWeights
  const index = rng.weightedIndex(CONDITION_IDS.map((condition) => weights[condition]))
  const condition = CONDITION_IDS[index]
  if (condition === undefined) throw new Error(`rollCondition: 权重下标 ${index} 越界`)
  return condition
}

/** 一次完整拾取判定 */
export function rollPickup(rng: Rng, config: FrozenGameConfig, zoneId: string): PickupRoll {
  const zone = findZone(config.zones.zones, zoneId)
  if (rng.chance(zone.emptyPointRate)) return { kind: 'empty' }

  const rarity = rollRarity(rng, config, zone.id)
  const candidates = availableItemsForZone(config.items.items, zone.id, rarity)
  if (candidates.length === 0) {
    throw new Error(
      `区域「${zone.name}」(${zone.id}) 的「${rarity}」档没有可用物品 —— check-config 的不变量 7 本应拦住`,
    )
  }

  return { kind: 'item', picked: { item: rng.pick(candidates), condition: rollCondition(rng, config) } }
}
