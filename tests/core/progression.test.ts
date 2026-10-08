import { describe, expect, it } from 'vitest'

import { loadConfig } from '../../src/config/loader'
import {
  canAffordTrip,
  canUpgradeTo,
  expansionCost,
  expToNextLevel,
  isZoneUnlocked,
  levelFromExp,
  maxLevel,
  nextLockedZone,
  spendTripStamina,
  staminaAfterOffline,
  unlockedZones,
  vehicleUpgradeCost,
  zoneStaminaCost,
} from '../../src/core/progression'

const config = loadConfig()

describe('progression · 等级曲线', () => {
  it('曲线首项为 0 → 0 经验就是 Lv1', () => {
    expect(levelFromExp(0, config)).toBe(1)
    expect(levelFromExp(19, config)).toBe(1)
  })

  it('达到门槛即升级，超出满级不再升级', () => {
    expect(levelFromExp(20, config)).toBe(2)
    expect(levelFromExp(49, config)).toBe(2)
    expect(levelFromExp(50, config)).toBe(3)
    expect(levelFromExp(640, config)).toBe(10)
    expect(levelFromExp(4900, config)).toBe(20)
    expect(levelFromExp(1_000_000, config)).toBe(maxLevel(config))
  })

  it('expToNextLevel：满级返回 null', () => {
    expect(expToNextLevel(0, config)).toBe(20)
    expect(expToNextLevel(4900, config)).toBeNull()
  })
})

describe('progression · 区域解锁（验收：达到解锁等级才开放区域）', () => {
  it('Lv1 只有街头巷尾，商业街区要 Lv3', () => {
    expect(unlockedZones(config, 1).map((zone) => zone.id)).toEqual(['street_alley'])
    expect(isZoneUnlocked({ unlockLevel: 3 }, 2)).toBe(false)
    expect(isZoneUnlocked({ unlockLevel: 3 }, 3)).toBe(true)
  })

  it('Lv6 开放老旧小区；Lv20 全区域开放', () => {
    expect(unlockedZones(config, 6).map((zone) => zone.id)).toEqual([
      'street_alley',
      'shopping_street',
      'old_apartment',
    ])
    expect(unlockedZones(config, 20)).toHaveLength(config.zones.zones.length)
  })

  it('nextLockedZone 给出下一个目标，全解锁后为 null', () => {
    expect(nextLockedZone(config, 1)?.id).toBe('shopping_street')
    expect(nextLockedZone(config, 19)?.id).toBe('landfill')
    expect(nextLockedZone(config, 20)).toBeNull()
  })
})

describe('progression · 体力', () => {
  it('单趟体力消耗来自配置', () => {
    expect(zoneStaminaCost('street_alley', config)).toBe(10)
    expect(zoneStaminaCost('landfill', config)).toBe(40)
  })

  it('体力不足不能出发；扣除后返回剩余体力', () => {
    expect(canAffordTrip('street_alley', 9, config)).toBe(false)
    expect(canAffordTrip('street_alley', 10, config)).toBe(true)
    expect(spendTripStamina('street_alley', 30, config)).toBe(20)
    expect(() => spendTripStamina('street_alley', 9, config)).toThrow()
  })

  it('离线恢复封顶 offlineStaminaCapHours，且不超过 maxStamina', () => {
    const { staminaRecoverPerMinute, offlineStaminaCapHours, maxStamina } = config.global.player
    const cappedRecovery = Math.min(maxStamina, offlineStaminaCapHours * 60 * staminaRecoverPerMinute)

    expect(staminaAfterOffline(0, offlineStaminaCapHours * 60, config)).toBeCloseTo(cappedRecovery, 10)
    expect(staminaAfterOffline(0, 10_000, config)).toBeCloseTo(cappedRecovery, 10)
    expect(staminaAfterOffline(maxStamina, 1000, config)).toBe(maxStamina)
    expect(staminaAfterOffline(10, -100, config)).toBe(10)
  })
})

describe('progression · 载具升级与背包扩容', () => {
  it('升级成本来自配置；初始载具不算可升级目标', () => {
    expect(vehicleUpgradeCost('handcart', config)).toBe(80)
    expect(canUpgradeTo('handcart', 79, config)).toBe(false)
    expect(canUpgradeTo('handcart', 80, config)).toBe(true)
    expect(canUpgradeTo('tote_bag', 1000, config)).toBe(false)
  })

  it('扩容成本 = 每格成本 × 每次扩容格数（对齐策划案 05 节：10 元 / +2 格）', () => {
    expect(expansionCost(config)).toBe(10)
  })
})
