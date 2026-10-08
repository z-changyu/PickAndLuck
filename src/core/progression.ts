import type { FrozenGameConfig } from '../config/loader'
import { findVehicle, findZone } from '../config/schema'

/**
 * 成长线：等级 / 区域解锁 / 载具升级 / 体力。
 * 所有阈值都来自 config，本文件不含任何硬编码的游戏数值。
 */

/** 时间单位换算常量（与游戏数值无关） */
const MINUTES_PER_HOUR = 60

/** 累计经验 → 等级（1 起步；曲线首项为 0 保证 Lv1 一定成立） */
export function levelFromExp(exp: number, config: FrozenGameConfig): number {
  const curve = config.global.level.cumulativeExp
  let level = 1
  for (let index = 0; index < curve.length; index += 1) {
    const threshold = curve[index]
    if (threshold === undefined || exp < threshold) break
    level = index + 1
  }
  return level
}

/** 满级 = 等级曲线长度 */
export const maxLevel = (config: FrozenGameConfig): number => config.global.level.cumulativeExp.length

/** 距离下一级还差多少经验；已满级返回 null */
export function expToNextLevel(exp: number, config: FrozenGameConfig): number | null {
  const next = config.global.level.cumulativeExp[levelFromExp(exp, config)]
  return next === undefined ? null : next - exp
}

/** 区域是否已解锁 */
export const isZoneUnlocked = (zone: { readonly unlockLevel: number }, level: number): boolean =>
  level >= zone.unlockLevel

export const unlockedZones = (config: FrozenGameConfig, level: number) =>
  config.zones.zones.filter((zone) => isZoneUnlocked(zone, level))

/** 下一个待解锁区域（界面用「还差 X 趟」引导） */
export function nextLockedZone(config: FrozenGameConfig, level: number) {
  const locked = config.zones.zones
    .filter((zone) => !isZoneUnlocked(zone, level))
    .sort((a, b) => a.unlockLevel - b.unlockLevel)
  return locked[0] ?? null
}

/** 初始区域 / 兜底区域：解锁等级最低的那个 */
export function defaultZone(config: FrozenGameConfig) {
  const zones = [...config.zones.zones].sort((a, b) => a.unlockLevel - b.unlockLevel)
  const first = zones[0]
  if (first === undefined) throw new Error('zones.json 里没有任何区域：defaultZone 无法确定起点')
  return first
}

/** 某区域的单趟体力消耗 */
export const zoneStaminaCost = (zoneId: string, config: FrozenGameConfig): number =>
  findZone(config.zones.zones, zoneId).staminaCost

/** 体力是否够跑一趟 */
export const canAffordTrip = (zoneId: string, stamina: number, config: FrozenGameConfig): boolean =>
  stamina >= zoneStaminaCost(zoneId, config)

/** 扣除一趟体力；不足时抛错（调用前应先用 canAffordTrip 判定） */
export function spendTripStamina(zoneId: string, stamina: number, config: FrozenGameConfig): number {
  const cost = zoneStaminaCost(zoneId, config)
  if (stamina < cost) {
    throw new Error(`体力不足：区域 ${zoneId} 需要 ${cost}，当前 ${stamina}`)
  }
  return stamina - cost
}

/**
 * 离线体力恢复：按分钟线性恢复，最多结算 offlineStaminaCapHours 小时，
 * 且恢复后不超过 maxStamina。
 */
export function staminaAfterOffline(stamina: number, minutesAway: number, config: FrozenGameConfig): number {
  const { staminaRecoverPerMinute, offlineStaminaCapHours, maxStamina } = config.global.player
  const effectiveMinutes = Math.min(Math.max(minutesAway, 0), offlineStaminaCapHours * MINUTES_PER_HOUR)
  return Math.min(maxStamina, stamina + effectiveMinutes * staminaRecoverPerMinute)
}

/** 载具升级成本（初始载具为 0） */
export const vehicleUpgradeCost = (vehicleId: string, config: FrozenGameConfig): number =>
  findVehicle(config.vehicles.vehicles, vehicleId).upgradeCostFromPrev

/** 钱够不够升到这级；初始载具（成本 0）不算可升级目标 */
export function canUpgradeTo(vehicleId: string, money: number, config: FrozenGameConfig): boolean {
  const cost = vehicleUpgradeCost(vehicleId, config)
  return cost > 0 && money >= cost
}

/** 一次背包扩容的成本 = 每格成本 × 每次扩容格数 */
export const expansionCost = (config: FrozenGameConfig): number =>
  config.global.grids.expandCostPerGrid * config.global.grids.expandGrids
