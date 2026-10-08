import type { FrozenGameConfig } from '../config/loader'
import { RARITY_IDS, findZone } from '../config/schema'
import type { RarityId } from '../config/schema'
import { tryAdd } from './inventory'
import type { Inventory } from './inventory'
import { rollPickup } from './pickup'
import type { PickedItem } from './pickup'
import type { Rng } from './rng'

/**
 * 一趟拾取（trip）：进入区域后点垃圾点的全过程。
 *
 * 纯逻辑、不含任何渲染 —— 渲染层只负责把 outcome 画出来（飘字 / 空空如也 / 装不下）。
 * 一趟的结束由背包容量自然决定（格子制背包就是逼玩家取舍），或玩家主动回程。
 * 体力属于玩家而不是这一趟（扣体力在 progression.spendTripStamina），所以这里不碰它。
 */

export interface TripState {
  readonly zoneId: string
  readonly inventory: Inventory
  /** 本次点过的垃圾点数（含假点、含装不下的） */
  readonly taps: number
  /** 踩到的假点数（「空空如也」） */
  readonly emptyTaps: number
  /** 本次真正捡到的各档件数 —— 与区域 dropRates 对比就靠它 */
  readonly rarityCounts: Readonly<Record<RarityId, number>>
}

/** 点一次垃圾点的结果 */
export type PickOutcome =
  /** 假点：这个垃圾点是空的 */
  | { readonly kind: 'empty' }
  /** 捡到了 */
  | { readonly kind: 'picked'; readonly picked: PickedItem }
  /** 背包放不下（多格物品挤不进剩余格子）—— 物品留在原地，玩家可以选择回程 */
  | { readonly kind: 'full'; readonly picked: PickedItem }

/**
 * 开始一趟。只做状态初始化与区域校验：
 * 区域是否存在（findZone 会抛）、体力够不够、玩家等级能不能进，都由调用方先用 progression 判定。
 */
export function startTrip(config: FrozenGameConfig, zoneId: string, inventory: Inventory): TripState {
  const zone = findZone(config.zones.zones, zoneId)

  return {
    zoneId: zone.id,
    inventory,
    taps: 0,
    emptyTaps: 0,
    // 五档齐全（类型上强制），避免漏档导致统计口径错
    rarityCounts: { white: 0, green: 0, blue: 0, purple: 0, gold: 0 },
  }
}

/** 点一次垃圾点：假点 → 稀有度 → 具体品类 → 品相（全在 pickup 里），然后尝试装包 */
export function pickAt(
  rng: Rng,
  config: FrozenGameConfig,
  trip: TripState,
): { readonly trip: TripState; readonly outcome: PickOutcome } {
  const roll = rollPickup(rng, config, trip.zoneId)
  const taps = trip.taps + 1

  if (roll.kind === 'empty') {
    return { trip: { ...trip, taps, emptyTaps: trip.emptyTaps + 1 }, outcome: { kind: 'empty' } }
  }

  const added = tryAdd(trip.inventory, roll.picked)
  if (!added.ok) {
    // 装不下就不进包，也不计入本次产出统计（它是"看到但拿不走"）
    return { trip: { ...trip, taps }, outcome: { kind: 'full', picked: roll.picked } }
  }

  const rarity = roll.picked.item.rarity
  return {
    trip: {
      ...trip,
      taps,
      inventory: added.inventory,
      rarityCounts: { ...trip.rarityCounts, [rarity]: (trip.rarityCounts[rarity] ?? 0) + 1 },
    },
    outcome: { kind: 'picked', picked: roll.picked },
  }
}

/** 本次真正捡到的件数 */
export const tripItemCount = (trip: TripState): number => trip.inventory.items.length

/** 本次已捡到的件数按档位汇总（与 dropRates 同口径：只看真正进包的） */
export const tripRarityTotal = (trip: TripState): number =>
  RARITY_IDS.reduce((total, rarity) => total + (trip.rarityCounts[rarity] ?? 0), 0)
