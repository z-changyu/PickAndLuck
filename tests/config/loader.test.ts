import { describe, expect, it } from 'vitest'

import { CONFIG_FILE_NAMES, ConfigValidationError, loadConfig } from '../../src/config/loader'
import type { RawConfigInput } from '../../src/config/loader'
import { at, cloneRaw, issuesOf } from './test-helpers'

describe('loadConfig', () => {
  it('正常配置可以加载，并聚合 6 份文件', () => {
    const config = loadConfig()

    expect(CONFIG_FILE_NAMES).toHaveLength(6)
    expect(config.rarity.rarities).toHaveLength(5)
    expect(config.items.items).toHaveLength(21)
    expect(config.zones.zones).toHaveLength(6)
    expect(config.gacha.boxes).toHaveLength(5)
    expect(config.vehicles.vehicles).toHaveLength(5)
    expect(config.global.game.codeName).toBe('pick-and-luck')
  })

  it('返回的配置被递归冻结（运行时不可被改写）', () => {
    const config = loadConfig()
    const zone = at(config.zones.zones, 0, 'zones')

    expect(Object.isFrozen(config)).toBe(true)
    expect(Object.isFrozen(config.zones.zones)).toBe(true)
    expect(Object.isFrozen(zone)).toBe(true)
    expect(Object.isFrozen(zone.dropRates)).toBe(true)

    const mutable = zone as unknown as { name: string }
    expect(() => Object.assign(mutable, { name: '被改掉了' })).toThrow(TypeError)
    expect(zone.name).toBe('街头巷尾')
  })

  it('校验失败时抛出 ConfigValidationError，且 message 第一行可直接定位问题', () => {
    const raw = cloneRaw()
    at(raw.zones.zones, 1, 'zones').dropRates.white = 0.56 - 0.01 // 合计 → 0.99

    let caught: unknown
    try {
      loadConfig(raw as unknown as RawConfigInput)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(ConfigValidationError)
    if (caught instanceof ConfigValidationError) {
      const [first] = caught.message.split('\n')
      expect(first).toContain('商业街区')
      expect(first).toContain('shopping_street')
      expect(caught.issues.length).toBeGreaterThan(0)
    }
  })
})

describe('dropRates 概率合计校验（T2 验收用例）', () => {
  it('某区域概率合计改成 0.99 → 报错并指出是哪个区域', () => {
    const raw = cloneRaw()
    at(raw.zones.zones, 1, 'zones').dropRates.white = 0.56 - 0.01

    const issues = issuesOf(raw)
    const text = issues.join('\n')

    expect(text).toContain('商业街区')
    expect(text).toContain('shopping_street')
    expect(text).toContain('dropRates')
    expect(text).toContain('0.99')
    expect(text).toContain('必须等于 1')
  })

  it('概率合计错误时不再叠加派生值噪音（只报根因）', () => {
    const raw = cloneRaw()
    at(raw.zones.zones, 1, 'zones').dropRates.white = 0.56 - 0.01

    const issues = issuesOf(raw)
    const zoneIssues = issues.filter((issue) => issue.includes('shopping_street'))

    expect(zoneIssues).toHaveLength(1)
  })

  it('概率合计通过但派生值 dropRatesSum 对不上 → 报错', () => {
    const raw = cloneRaw()
    const zone = at(raw.zones.zones, 0, 'zones')
    Object.assign(zone, { dropRatesSum: 0.9 })

    expect(issuesOf(raw).join('\n')).toContain('dropRatesSum')
  })
})

describe('跨文件引用校验', () => {
  it('盲盒 rates 合计不为 1 → 指出是哪款盲盒', () => {
    const raw = cloneRaw()
    at(raw.gacha.boxes, 0, 'boxes').rates.white = 0.65 - 0.01

    expect(issuesOf(raw).join('\n')).toMatch(/废品盲盒[\s\S]*junk_box/)
  })

  it('物品引用了不存在的区域 → 指出物品与区域名', () => {
    const raw = cloneRaw()
    const item = at(raw.items.items, 0, 'items')
    item.zones = ['atlantis']

    const text = issuesOf(raw).join('\n')
    expect(text).toContain('塑料瓶')
    expect(text).toContain('atlantis')
  })

  it('初始载具不在载具表中 → 报错并给出可选值', () => {
    const raw = cloneRaw()
    raw.global.player.initialVehicle = 'spaceship'

    const text = issuesOf(raw).join('\n')
    expect(text).toContain('spaceship')
    expect(text).toContain('initialVehicle')
  })

  it('区域缺少 zonePriceModifier → 报错', () => {
    const raw = cloneRaw()
    const zone = at(raw.zones.zones, 0, 'zones')
    zone.id = 'nowhere'

    expect(issuesOf(raw).join('\n')).toContain('zonePriceModifier')
  })

  it('载具格数没有递增 → 报错', () => {
    const raw = cloneRaw()
    at(raw.vehicles.vehicles, 1, 'vehicles').grids = 6

    const text = issuesOf(raw).join('\n')
    expect(text).toContain('小推车')
    expect(text).toContain('必须大于上一级')
  })
})
