import type { FrozenGameConfig } from '../config/loader'
import { findVehicle } from '../config/schema'
import { totalWeightKg } from './economy'
import type { PickedItem } from './pickup'

/**
 * 格子制背包。
 *
 * 容量 = 当前载具格数 + 已扩容格数 × 每次扩容格数（vehicles.json + global.grids）。
 * 所有操作都是不可变的（返回新背包），便于存档、回滚与调试面板「重放某一趟」。
 */

export interface Inventory {
  /** 总格数 */
  readonly capacity: number
  readonly items: readonly PickedItem[]
}

/** 背包容量（载具格数 + 扩容格数） */
export function capacityOf(vehicleId: string, expansions: number, config: FrozenGameConfig): number {
  const vehicle = findVehicle(config.vehicles.vehicles, vehicleId)
  return vehicle.grids + expansions * config.global.grids.expandGrids
}

export function createInventory(capacity: number): Inventory {
  if (!Number.isInteger(capacity) || capacity < 0) {
    throw new Error(`createInventory: capacity 必须是非负整数，收到 ${String(capacity)}`)
  }
  return { capacity, items: [] }
}

export const usedGrids = (inventory: Inventory): number =>
  inventory.items.reduce((total, picked) => total + picked.item.gridCost, 0)

export const remainingGrids = (inventory: Inventory): number => inventory.capacity - usedGrids(inventory)

export const canFit = (inventory: Inventory, picked: PickedItem): boolean =>
  picked.item.gridCost <= remainingGrids(inventory)

/** 拾取被拒的原因，界面据此给提示 */
export const PICKUP_REJECT_REASONS = ['not_enough_grids'] as const
export type PickupRejectReason = (typeof PICKUP_REJECT_REASONS)[number]

export type TryAddResult =
  | { readonly ok: true; readonly inventory: Inventory }
  | { readonly ok: false; readonly reason: PickupRejectReason }

/** 装包；装不下时返回原因而不是抛错（这是玩法路径，不是异常） */
export function tryAdd(inventory: Inventory, picked: PickedItem): TryAddResult {
  if (!canFit(inventory, picked)) return { ok: false, reason: 'not_enough_grids' }
  return { ok: true, inventory: { capacity: inventory.capacity, items: [...inventory.items, picked] } }
}

/** 扩容：给背包加格数（成本见 progression.expansionCost） */
export function expandInventory(inventory: Inventory, grids: number): Inventory {
  if (!Number.isInteger(grids) || grids <= 0) {
    throw new Error(`expandInventory: grids 必须是正整数，收到 ${String(grids)}`)
  }
  return { capacity: inventory.capacity + grids, items: inventory.items }
}

/** 清空（垃圾场结算后） */
export const clearInventory = (inventory: Inventory): Inventory => ({
  capacity: inventory.capacity,
  items: [],
})

/** 背包总重量（kg） */
export const inventoryWeightKg = (inventory: Inventory): number => totalWeightKg(inventory.items)
