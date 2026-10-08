import { ConfigValidationError, defaultRawConfig, loadConfig } from '../../src/config/loader'
import type { RawConfigInput } from '../../src/config/loader'

/**
 * 测试用「宽松视图」：只声明用例会改到的字段。
 * 这样既能自由制造错误配置，又不用在测试里写 any。
 */
export interface LooseRaw {
  global: {
    player: {
      initialVehicle: string
      maxStamina: number
      staminaRecoverPerMinute: number
      offlineStaminaCapHours: number
    }
    sell: { conditionWeights: Record<string, number> }
    level: { cumulativeExp: number[] }
  }
  rarity: { rarities: Array<{ id: string; order: number }> }
  items: { items: Array<{ id: string; name: string; rarity: string; zones: string[] }> }
  zones: {
    zones: Array<{
      id: string
      name: string
      unlockLevel: number
      staminaCost: number
      dropRates: Record<string, number>
      emptyPointRate: number
    }>
  }
  gacha: {
    pity: { targetRarity: string }
    boxes: Array<{
      id: string
      name: string
      price: number
      rates: Record<string, number>
      pityCounter: number | null
      materialReturnRate?: number
      returnRateWithPity?: number
    }>
  }
  vehicles: {
    vehicles: Array<{ id: string; name: string; grids: number; upgradeCostFromPrev: number }>
  }
}

/** 深拷贝一份正常配置，供用例按需改坏 */
export const cloneRaw = (): LooseRaw => structuredClone(defaultRawConfig) as unknown as LooseRaw

export function issuesOf(raw: LooseRaw): string[] {
  try {
    loadConfig(raw as unknown as RawConfigInput)
  } catch (error) {
    if (error instanceof ConfigValidationError) return [...error.issues]
    throw error
  }
  throw new Error('期望配置校验失败，实际却通过了')
}

export function expectIssue(raw: LooseRaw, expected: readonly string[]): void {
  const issues = issuesOf(raw)
  const text = issues.join('\n')
  for (const fragment of expected) {
    if (!text.includes(fragment)) {
      throw new Error(`期望校验信息包含「${fragment}」，实际信息为：\n${text}`)
    }
  }
}

/** 取得数组中指定下标的元素，缺失时直接失败（避免在用例里写非空断言） */
export function at<T>(list: readonly T[], index: number, label: string): T {
  const value = list[index]
  if (value === undefined) throw new Error(`测试数据缺少 ${label}[${index}]`)
  return value
}
