import type { ZodError } from 'zod'

// 注意：本文件被 vite.config.ts 静态引用，而 Vite 未来的原生配置文件加载器要求
// 「显式扩展名 + import attributes」，因此这条依赖链上的 import 写成完整形式
// （tsconfig.json 已开启 allowImportingTsExtensions）。
import gachaJson from '../../config/gacha.json' with { type: 'json' }
import globalJson from '../../config/global.json' with { type: 'json' }
import itemsJson from '../../config/items.json' with { type: 'json' }
import rarityJson from '../../config/rarity.json' with { type: 'json' }
import vehiclesJson from '../../config/vehicles.json' with { type: 'json' }
import zonesJson from '../../config/zones.json' with { type: 'json' }
import { gameConfigSchema } from './schema.ts'
import type { GameConfig } from './schema.ts'

/**
 * 配置加载：读 config/*.json → Zod 校验 → 深冻结。
 *
 * 纯逻辑，无 DOM / 无渲染依赖，所以：
 *   · 浏览器（阶段一）可以直接静态 import；
 *   · Node 单测与 CLI（npm run check-config）可以复用同一份代码。
 */

/** config/ 目录下的 6 份运行时配置文件 */
export const CONFIG_FILE_NAMES = [
  'global.json',
  'rarity.json',
  'items.json',
  'zones.json',
  'gacha.json',
  'vehicles.json',
] as const

/** 未校验的原始配置（结构上是 unknown，交给 Zod 判定） */
export interface RawConfigInput {
  global: unknown
  rarity: unknown
  items: unknown
  zones: unknown
  gacha: unknown
  vehicles: unknown
}

/** 6 份 JSON 打包后的原始输入 */
export const defaultRawConfig: RawConfigInput = {
  global: globalJson,
  rarity: rarityJson,
  items: itemsJson,
  zones: zonesJson,
  gacha: gachaJson,
  vehicles: vehiclesJson,
}

/** 递归只读：core 层拿到的配置在类型上就不允许被改写 */
export type DeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T

export type FrozenGameConfig = DeepReadonly<GameConfig>

/** 配置校验失败。message 的第一行一定是可以直接定位到具体区域 / 盲盒 / 物品的那一条。 */
export class ConfigValidationError extends Error {
  readonly issues: readonly string[]

  constructor(issues: readonly string[]) {
    const [first, ...rest] = issues
    const message =
      first === undefined
        ? '配置校验失败'
        : rest.length === 0
          ? `配置校验失败：${first}`
          : [`配置校验失败：「${first}」`, ...rest.map((line, index) => `  ${index + 2}) ${line}`)].join('\n')
    super(message)
    this.name = 'ConfigValidationError'
    this.issues = issues
  }
}

function formatPath(path: readonly (string | number)[]): string {
  if (path.length === 0) return '<root>'
  return path.reduce<string>(
    (acc, segment) => (typeof segment === 'number' ? `${acc}[${segment}]` : acc === '' ? segment : `${acc}.${segment}`),
    '',
  )
}

function formatZodIssues(error: ZodError): string[] {
  return error.issues.map((issue) => `${formatPath(issue.path)}: ${issue.message}`)
}

/** 递归冻结，防止运行时被意外改写 */
export function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
  }
  return value as DeepReadonly<T>
}

/**
 * 加载并校验配置。校验失败抛 ConfigValidationError。
 *
 * @param raw 原始配置，默认使用 config/ 下的 6 份 JSON（测试可传入故意改坏的数据）
 */
export function loadConfig(raw: RawConfigInput = defaultRawConfig): FrozenGameConfig {
  const result = gameConfigSchema.safeParse(raw)
  if (!result.success) {
    throw new ConfigValidationError(formatZodIssues(result.error))
  }
  return deepFreeze(result.data)
}
