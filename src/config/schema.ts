import { z } from 'zod'

/**
 * config/ 下 6 份 JSON 的 Schema 与「关键不变量」的唯一实现处。
 *
 * 设计原则（见 README 第 0 节）：
 *   1. 结构错误（少字段、类型错）由 Zod 本身报出；
 *   2. 跨文件引用（物品引用的区域、载具引用的区域、初始载具）由 superRefine 报出；
 *   3. 派生值一致性（dropRatesSum / avgUnitValue / expectedMaterialValue / materialReturnRate…）
 *      由 superRefine 重算比对 —— 防止「改了概率却忘了改派生列」；
 *   4. CODEBUDDY.md 里的关键不变量（返还率区间、区域收益增幅、攒钱趟数）在这里硬拦截。
 *
 * 所有报错信息都必须能回答「是哪个区域 / 哪款盲盒 / 哪件物品出了问题」。
 */

// ---------------------------------------------------------------- 常量

/** 五档稀有度 id，顺序即「白 → 绿 → 蓝 → 紫 → 金」 */
export const RARITY_IDS = ['white', 'green', 'blue', 'purple', 'gold'] as const
export type RarityId = (typeof RARITY_IDS)[number]

/** 品相三档 id，顺序即「完好 → 磨损 → 破损」 */
export const CONDITION_IDS = ['pristine', 'worn', 'broken'] as const
export type ConditionId = (typeof CONDITION_IDS)[number]

/** 概率合计必须 = 1 的容差 */
export const RATE_TOLERANCE = 1e-6
/** 金额类派生值容差（元） */
export const MONEY_TOLERANCE = 0.01
/** 比率类派生值容差 */
export const RATIO_TOLERANCE = 0.005
/** 趟数类派生值容差 */
export const TRIPS_TOLERANCE = 0.05

/** 盲盒材料返还率健康区间 —— CODEBUDDY.md 关键不变量 2 */
export const MATERIAL_RETURN_RATE_MIN = 0.55
export const MATERIAL_RETURN_RATE_MAX = 0.65

/** 区域「每体力收益」相邻档位允许的最大增幅 —— 关键不变量 5 */
export const MAX_PER_STAMINA_GROWTH = 0.1

/** 载具升级「攒钱趟数」区间 —— 关键不变量 6 */
export const SAVE_UP_TRIPS_MIN = 8
export const SAVE_UP_TRIPS_MAX = 18

/** 计算「每体力收益」时使用的参考载具格数（与数值框架口径一致） */
export const REFERENCE_GRIDS = 12

/** 体力满仓时长区间（分钟）：低于下限体力形同取消，高于上限一天玩不到 3 次会话 */
export const STAMINA_REFILL_MINUTES_MIN = 90
export const STAMINA_REFILL_MINUTES_MAX = 240

/** 满仓体力至少要够跑几趟默认区域（保证新手不被体力卡死） */
export const MIN_TRIPS_PER_STAMINA_BAR = 3

// ---------------------------------------------------------------- 基础片段

const positiveNumber = z.number().positive()
const nonNegativeNumber = z.number().nonnegative()
const positiveInt = z.number().int().positive()
const rate = z.number().min(0).max(1)

/** 五档稀有度的概率分布（五档必须齐全，缺一档即为结构错误） */
export const rarityRatesSchema = z.object({
  white: rate,
  green: rate,
  blue: rate,
  purple: rate,
  gold: rate,
})
export type RarityRates = z.infer<typeof rarityRatesSchema>

export const sumRates = (rates: RarityRates): number =>
  rates.white + rates.green + rates.blue + rates.purple + rates.gold

// ---------------------------------------------------------------- global.json

const conditionMultipliersSchema = z
  .object({
    pristine: positiveNumber,
    worn: positiveNumber,
    broken: positiveNumber,
  })
  .refine((m) => m.pristine >= m.worn && m.worn >= m.broken, {
    message: '品相系数必须递减：pristine ≥ worn ≥ broken',
  })

/** 品相出现权重（合计必须 = 1，在 superRefine 里校验） */
const conditionWeightsSchema = z.object({
  pristine: rate,
  worn: rate,
  broken: rate,
})

export const globalConfigSchema = z.object({
  _note: z.string().optional(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'version 必须形如 1.0.0'),
  game: z.object({
    name: z.string().min(1),
    codeName: z.string().min(1),
    subtitle: z.string().min(1),
  }),
  player: z
    .object({
      initialMoney: nonNegativeNumber,
      initialVehicle: z.string().min(1),
      initialStamina: positiveInt,
      maxStamina: positiveInt,
      staminaRecoverPerMinute: nonNegativeNumber,
      offlineStaminaCapHours: positiveInt,
      adStaminaRefillAmount: nonNegativeNumber,
      adStaminaRefillDailyLimit: positiveInt,
    })
    .refine((p) => p.initialStamina <= p.maxStamina, {
      path: ['initialStamina'],
      message: 'initialStamina 不能大于 maxStamina',
    }),
  level: z.object({
    /** 1 元出售额折算多少经验 */
    expPerCurrency: positiveNumber,
    /** 累计经验门槛：索引 i → 达到 Lv(i+1) 所需累计经验，首项必须为 0 */
    cumulativeExp: z.array(nonNegativeNumber).min(2, 'cumulativeExp 至少要有 2 个等级'),
  }),
  sell: z.object({
    conditionMultiplier: conditionMultipliersSchema,
    conditionWeights: conditionWeightsSchema,
    zonePriceModifier: z.record(z.string(), positiveNumber),
  }),
  grids: z.object({
    /** 每次背包扩容增加的格数 */
    expandGrids: positiveInt,
    /** 每格扩容成本（元） */
    expandCostPerGrid: positiveNumber,
  }),
  /**
   * 埋点验收指标（启动包 README 第 6 节 / 策划案「上线前必须盯住的数字」）。
   * 只放本地就能算出来的四项；D1 留存与广告渗透率需要多日、多账号数据，由分析平台算。
   */
  analytics: z
    .object({
      sessionMinutesMin: positiveNumber,
      sessionMinutesMax: positiveNumber,
      sessionTripsMin: positiveInt,
      firstGachaOpenMinutesMax: positiveNumber,
      /** 货架 → 购买转化率下限（0–1） */
      gachaBuyConversionMin: z.number().gt(0).max(1),
    })
    .refine((analytics) => analytics.sessionMinutesMin < analytics.sessionMinutesMax, {
      path: ['sessionMinutesMin'],
      message: 'sessionMinutesMin 必须小于 sessionMinutesMax',
    }),
  debug: z.object({
    rngSeed: z.number().int(),
  }),
})
export type GlobalConfig = z.infer<typeof globalConfigSchema>

// ---------------------------------------------------------------- rarity.json

export const rarityEntrySchema = z.object({
  id: z.enum(RARITY_IDS),
  code: z.string().length(1),
  name: z.string().min(1),
  order: positiveInt,
  /** 盲盒开出该档「材料」时可直接卖出的单价（返还率的分子） */
  materialValue: positiveNumber,
  /** 藏品贡献的图鉴点 */
  codexPoints: positiveInt,
  /** 街头拾取到的该档物品平均单价，用于区域收益估算 */
  streetAvgValue: positiveNumber,
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'color 必须是 #RRGGBB'),
})
export type RarityEntry = z.infer<typeof rarityEntrySchema>

export const rarityConfigSchema = z.object({
  _note: z.string().optional(),
  rarities: z.array(rarityEntrySchema).length(RARITY_IDS.length, `稀有度必须恰好 ${RARITY_IDS.length} 档`),
})

// ---------------------------------------------------------------- items.json

export const itemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  rarity: z.enum(RARITY_IDS),
  /** 可出现的区域 id 列表；"all" 表示全区 */
  zones: z.array(z.string().min(1)).min(1, 'zones 至少写一个区域 id（或 "all"）'),
  weightKg: positiveNumber,
  unitPrice: positiveNumber,
  gridCost: positiveInt,
  note: z.string(),
})
export type ItemConfig = z.infer<typeof itemSchema>

export const itemsConfigSchema = z.object({
  _note: z.string().optional(),
  items: z.array(itemSchema).min(1),
})

// ---------------------------------------------------------------- zones.json

export const zoneSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  unlockLevel: positiveInt,
  staminaCost: positiveInt,
  dropRates: rarityRatesSchema,
  /** 派生值：dropRates 合计，仅作断言用 */
  dropRatesSum: z.number().optional(),
  /** 派生值：Σ(概率 × 该档街头均价) */
  avgUnitValue: z.number().optional(),
  /** 派生值：每体力收益（@12 格载具） */
  perStaminaAtRef12Grids: z.number().optional(),
  /** 假点（已空的垃圾点）出现概率 */
  emptyPointRate: rate,
  feature: z.string(),
})
export type ZoneConfig = z.infer<typeof zoneSchema>

export const zonesConfigSchema = z.object({
  _note: z.string().optional(),
  zones: z.array(zoneSchema).min(1),
})

// ---------------------------------------------------------------- gacha.json

export const pitySchema = z.object({
  /** 保底目标档：连续未出该档（含更高档）达到 pityCounter 次时，下一抽必出该档以上 */
  targetRarity: z.enum(RARITY_IDS),
  scope: z.enum(['per_box', 'global']),
  resetOnHit: z.boolean(),
  newPlayerFirstPullMinRarity: z.enum(RARITY_IDS),
})

export const gachaBoxSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  price: positiveNumber,
  rates: rarityRatesSchema,
  /** 保底计数：连续未出保底档的抽数上限；null = 该盒不设保底 */
  pityCounter: z.number().int().min(2).nullable(),
  /** 派生值 */
  ratesSum: z.number().optional(),
  expectedMaterialValue: z.number().optional(),
  materialReturnRate: z.number().optional(),
  /** 派生值：含保底的实测返还率（解析解，见 expectedReturnRateWithPity） */
  returnRateWithPity: z.number().optional(),
  expectedCodexPoints: z.number().optional(),
  isStoryBox: z.boolean(),
  positioning: z.string(),
})
export type GachaBoxConfig = z.infer<typeof gachaBoxSchema>

export const gachaConfigSchema = z.object({
  _note: z.string().optional(),
  pity: pitySchema,
  cost: z.object({
    currency: z.string().min(1),
  }),
  duplicateConvert: z.object({
    enabled: z.boolean(),
    output: z.string().min(1),
    shardPerRarity: z.object({
      white: positiveInt,
      green: positiveInt,
      blue: positiveInt,
      purple: positiveInt,
      gold: positiveInt,
    }),
    shardExchange: z
      .array(
        z.object({
          shards: positiveInt,
          reward: z.string().min(1),
          note: z.string(),
        }),
      )
      .min(1),
  }),
  boxes: z.array(gachaBoxSchema).min(1),
})

// ---------------------------------------------------------------- vehicles.json

export const vehicleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  grids: positiveInt,
  upgradeCostFromPrev: nonNegativeNumber,
  note: z.string(),
  referenceZone: z.string().min(1),
})
export type VehicleConfig = z.infer<typeof vehicleSchema>

export const upgradeCheckpointSchema = z.object({
  to: z.string().min(1),
  saveUpTrips: z.number().optional(),
  paybackTrips: z.number().optional(),
  beforeTripRevenue: z.number().optional(),
  afterTripRevenue: z.number().optional(),
})

export const vehiclesConfigSchema = z.object({
  _note: z.string().optional(),
  vehicles: z.array(vehicleSchema).min(2),
  upgradeCheckpoints: z.array(upgradeCheckpointSchema),
})

// ---------------------------------------------------------------- 顶层

export const rawConfigSchema = z.object({
  global: globalConfigSchema,
  rarity: rarityConfigSchema,
  items: itemsConfigSchema,
  zones: zonesConfigSchema,
  gacha: gachaConfigSchema,
  vehicles: vehiclesConfigSchema,
})
export type RawGameConfig = z.infer<typeof rawConfigSchema>

// ---------------------------------------------------------------- 辅助

const fmt = (value: number): string => Number(value.toFixed(6)).toString()
const nearlyEqual = (actual: number, expected: number, tolerance: number): boolean =>
  Math.abs(actual - expected) <= tolerance

function findDuplicate(values: readonly (string | number)[]): string | null {
  const seen = new Set<string | number>()
  for (const value of values) {
    if (seen.has(value)) return String(value)
    seen.add(value)
  }
  return null
}

const percent = (value: number): string => `${(value * 100).toFixed(2)}%`

/**
 * 某区域某档位「拾得到」的物品。
 * 物品的 zones 里含 "all" 视为全区可用 —— 抽物品时必须用这个函数过滤，
 * 否则会抽到该区域根本不该出现的品类（T3 pickup 的唯一入口）。
 */
export interface ZoneScopedItem {
  readonly rarity: RarityId
  readonly zones: readonly string[]
}

export function availableItemsForZone<T extends ZoneScopedItem>(
  items: readonly T[],
  zoneId: string,
  rarity: RarityId,
): T[] {
  return items.filter(
    (item) => item.rarity === rarity && (item.zones.includes('all') || item.zones.includes(zoneId)),
  )
}

/** 按 id 取区域；找不到直接抛错（配置校验已保证引用完整，这里只是兜底） */
export function findZone<T extends { readonly id: string }>(zones: readonly T[], zoneId: string): T {
  const zone = zones.find((candidate) => candidate.id === zoneId)
  if (zone === undefined) throw new Error(`未知区域 "${zoneId}"：config/zones.json 里没有这个 id`)
  return zone
}

/** 按 id 取载具；找不到直接抛错 */
export function findVehicle<T extends { readonly id: string }>(vehicles: readonly T[], vehicleId: string): T {
  const vehicle = vehicles.find((candidate) => candidate.id === vehicleId)
  if (vehicle === undefined) throw new Error(`未知载具 "${vehicleId}"：config/vehicles.json 里没有这个 id`)
  return vehicle
}

/** 按 id 取盲盒；找不到直接抛错 */
export function findBox<T extends { readonly id: string }>(boxes: readonly T[], boxId: string): T {
  const box = boxes.find((candidate) => candidate.id === boxId)
  if (box === undefined) throw new Error(`未知盲盒 "${boxId}"：config/gacha.json 里没有这个 id`)
  return box
}

/** 按 id 取稀有度定义；找不到直接抛错 */
export function findRarity<T extends { readonly id: string }>(rarities: readonly T[], rarityId: string): T {
  const rarity = rarities.find((candidate) => candidate.id === rarityId)
  if (rarity === undefined) throw new Error(`未知稀有度 "${rarityId}"：config/rarity.json 里没有这个 id`)
  return rarity
}

/** 区域平均单件价值：优先用声明值（策划口径），缺失时按公式重算 */
export function zoneAvgUnitValue(zone: ZoneConfig, streetAvgValue: ReadonlyMap<RarityId, number>): number {
  if (zone.avgUnitValue !== undefined) return zone.avgUnitValue
  return RARITY_IDS.reduce((acc, id) => acc + zone.dropRates[id] * (streetAvgValue.get(id) ?? 0), 0)
}

/** 目标档及以上的概率合计（保底判定的 p） */
export function rateAtLeast(rates: RarityRates, targetRarity: RarityId): number {
  const targetRank = RARITY_IDS.indexOf(targetRarity)
  return RARITY_IDS.reduce((total, rarity, rank) => (rank >= targetRank ? total + rates[rarity] : total), 0)
}

/**
 * 含保底的材料返还率 —— 解析解，等价于十万次模拟，但瞬时且完全确定。
 *
 * 保底把「连续未出目标档」的抽数截断在 pityCounter：
 *   f(c) = 自然EV + (1-p)·f(c+1)， f(N-1) = 目标档的条件期望价值
 *   L(c) = 1 + (1-p)·L(c+1)，      L(N-1) = 1
 *   含保底返还率 = f(0) / (L(0) × 售价)
 * 其中 p = 目标档及以上的概率合计，p 内部按原始比例重新归一化（与 gacha.ts 一致）。
 *
 * 不建模「新手首抽保护」：每个账号只作用一次，长期占比可忽略。
 */
export function expectedReturnRateWithPity(
  box: { readonly price: number; readonly rates: RarityRates; readonly pityCounter: number | null },
  materialValue: ReadonlyMap<RarityId, number>,
  targetRarity: RarityId,
): number {
  const naturalValue = RARITY_IDS.reduce(
    (total, rarity) => total + box.rates[rarity] * (materialValue.get(rarity) ?? 0),
    0,
  )
  const targetRate = rateAtLeast(box.rates, targetRarity)
  const counter = box.pityCounter
  if (counter === null || targetRate <= 0) return naturalValue / box.price

  const rankOfTarget = RARITY_IDS.indexOf(targetRarity)
  const forcedValue =
    RARITY_IDS.reduce(
      (total, rarity, rank) =>
        rank >= rankOfTarget ? total + box.rates[rarity] * (materialValue.get(rarity) ?? 0) : total,
      0,
    ) / targetRate

  let expectedValue = forcedValue
  let expectedLength = 1
  for (let index = counter - 2; index >= 0; index -= 1) {
    expectedValue = naturalValue + (1 - targetRate) * expectedValue
    expectedLength = 1 + (1 - targetRate) * expectedLength
  }
  return expectedValue / (expectedLength * box.price)
}

/** 体力满仓时长（分钟）= 上限 ÷ 每分钟恢复量 */
export function staminaRefillMinutes(player: {
  readonly maxStamina: number
  readonly staminaRecoverPerMinute: number
}): number {
  if (player.staminaRecoverPerMinute <= 0) return Number.POSITIVE_INFINITY
  return player.maxStamina / player.staminaRecoverPerMinute
}

/** 区域每体力收益（@REFERENCE_GRIDS 格载具） */
export function zonePerStamina(
  zone: ZoneConfig,
  streetAvgValue: ReadonlyMap<RarityId, number>,
): number {
  return (REFERENCE_GRIDS * zoneAvgUnitValue(zone, streetAvgValue)) / zone.staminaCost
}

// ---------------------------------------------------------------- 跨文件 / 不变量校验

export const gameConfigSchema = rawConfigSchema.superRefine((config, ctx) => {
  const fail = (path: readonly (string | number)[], message: string): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path], message })
  }

  const { rarities } = config.rarity
  const streetAvgValue = new Map<RarityId, number>(rarities.map((r) => [r.id, r.streetAvgValue]))
  const materialValue = new Map<RarityId, number>(rarities.map((r) => [r.id, r.materialValue]))
  const codexPoints = new Map<RarityId, number>(rarities.map((r) => [r.id, r.codexPoints]))

  // ------- 稀有度：五档齐全、id / order 不重复 -------
  const rarityIds = rarities.map((r) => r.id)
  for (const id of RARITY_IDS) {
    if (!rarityIds.includes(id)) {
      fail(['rarity', 'rarities'], `缺少稀有度定义 "${id}"，五档稀有度必须齐全`)
    }
  }
  const duplicateRarityId = findDuplicate(rarityIds)
  if (duplicateRarityId !== null) {
    fail(['rarity', 'rarities'], `稀有度 id 重复："${duplicateRarityId}"`)
  }
  const duplicateRarityOrder = findDuplicate(rarities.map((r) => r.order))
  if (duplicateRarityOrder !== null) {
    fail(['rarity', 'rarities'], `稀有度 order 重复："${duplicateRarityOrder}"`)
  }

  // ------- 区域 -------
  const zoneIds = config.zones.zones.map((zone) => zone.id)
  const zoneById = new Map(config.zones.zones.map((zone) => [zone.id, zone]))

  const duplicateZoneId = findDuplicate(zoneIds)
  if (duplicateZoneId !== null) {
    fail(['zones', 'zones'], `区域 id 重复："${duplicateZoneId}"`)
  }

  config.zones.zones.forEach((zone, index) => {
    const base = ['zones', 'zones', index] as const

    // 不变量：每个区域 × 每个非零概率档位都必须有可拾取物品（否则抽取阶段必然空档）
    for (const rarity of RARITY_IDS) {
      if (zone.dropRates[rarity] > 0 && availableItemsForZone(config.items.items, zone.id, rarity).length === 0) {
        fail(
          [...base, 'dropRates', rarity],
          `区域「${zone.name}」(${zone.id}) 的「${rarity}」档概率为 ${percent(zone.dropRates[rarity])}，` +
            `但 items.json 里没有任何可用物品（需要至少一件 rarity="${rarity}"、zones 含 "${zone.id}" 或 "all" 的物品）`,
        )
      }
    }

    if (zone.emptyPointRate >= 1) {
      fail(
        [...base, 'emptyPointRate'],
        `区域「${zone.name}」(${zone.id}) 的 emptyPointRate=${zone.emptyPointRate}，` +
          '假点率必须小于 1，否则该区域永远捡不到东西',
      )
    }

    const sum = sumRates(zone.dropRates)

    // 不变量：概率合计 = 1
    if (!nearlyEqual(sum, 1, RATE_TOLERANCE)) {
      fail(
        [...base, 'dropRates'],
        `区域「${zone.name}」(${zone.id}) 的 dropRates 概率合计为 ${fmt(sum)}，必须等于 1（容差 ${RATE_TOLERANCE}）`,
      )
      // 概率本身就不合法时，后续派生值校验没有意义，跳过以免噪音
      return
    }

    if (zone.dropRatesSum !== undefined && !nearlyEqual(zone.dropRatesSum, sum, RATIO_TOLERANCE)) {
      fail(
        [...base, 'dropRatesSum'],
        `区域「${zone.name}」(${zone.id}) 的 dropRatesSum=${zone.dropRatesSum} 与 dropRates 实际合计 ${fmt(sum)} 不一致`,
      )
    }

    if (config.global.sell.zonePriceModifier[zone.id] === undefined) {
      fail(
        [...base, 'id'],
        `区域「${zone.name}」(${zone.id}) 在 global.sell.zonePriceModifier 中缺少价格系数`,
      )
    }

    const computedAvg = RARITY_IDS.reduce(
      (acc, id) => acc + zone.dropRates[id] * (streetAvgValue.get(id) ?? 0),
      0,
    )
    if (zone.avgUnitValue !== undefined && !nearlyEqual(zone.avgUnitValue, computedAvg, MONEY_TOLERANCE)) {
      fail(
        [...base, 'avgUnitValue'],
        `区域「${zone.name}」(${zone.id}) 的 avgUnitValue=${zone.avgUnitValue} 与重算值 ${fmt(computedAvg)} 不一致（Σ(概率 × 该档街头均价)）`,
      )
    }

    const computedPerStamina = (REFERENCE_GRIDS * zoneAvgUnitValue(zone, streetAvgValue)) / zone.staminaCost
    if (
      zone.perStaminaAtRef12Grids !== undefined &&
      !nearlyEqual(zone.perStaminaAtRef12Grids, computedPerStamina, MONEY_TOLERANCE)
    ) {
      fail(
        [...base, 'perStaminaAtRef12Grids'],
        `区域「${zone.name}」(${zone.id}) 的 perStaminaAtRef12Grids=${zone.perStaminaAtRef12Grids} 与重算值 ${fmt(computedPerStamina)} 不一致（${REFERENCE_GRIDS} × 平均单件价值 ÷ 单趟体力）`,
      )
    }
  })

  // ------- 不变量：区域每体力收益温和增长（≤ MAX_PER_STAMINA_GROWTH） -------
  const zonesByLevel = [...config.zones.zones].sort((a, b) => a.unlockLevel - b.unlockLevel)
  for (let i = 1; i < zonesByLevel.length; i += 1) {
    const prev = zonesByLevel[i - 1]
    const curr = zonesByLevel[i]
    if (prev === undefined || curr === undefined) continue
    const prevValue = zonePerStamina(prev, streetAvgValue)
    const currValue = zonePerStamina(curr, streetAvgValue)
    if (prevValue <= 0) continue
    const growth = currValue / prevValue - 1
    if (growth > MAX_PER_STAMINA_GROWTH + RATE_TOLERANCE) {
      const index = config.zones.zones.indexOf(curr)
      fail(
        ['zones', 'zones', index, 'perStaminaAtRef12Grids'],
        `区域「${curr.name}」(${curr.id}) 的每体力收益比上一档「${prev.name}」高 ${percent(growth)}，` +
          `超过上限 ${percent(MAX_PER_STAMINA_GROWTH)}（见 CODEBUDDY.md 关键不变量 5）`,
      )
    }
  }

  // ------- 品相权重 -------
  const weights = config.global.sell.conditionWeights
  const weightSum = weights.pristine + weights.worn + weights.broken
  if (!nearlyEqual(weightSum, 1, RATE_TOLERANCE)) {
    fail(
      ['global', 'sell', 'conditionWeights'],
      `品相出现权重合计为 ${fmt(weightSum)}，必须等于 1（容差 ${RATE_TOLERANCE}；见 config/global.json → sell.conditionWeights）`,
    )
  }

  // ------- 等级曲线 -------
  const { cumulativeExp } = config.global.level
  const firstExp = cumulativeExp[0]
  if (firstExp !== 0) {
    fail(
      ['global', 'level', 'cumulativeExp', 0],
      `等级曲线首项必须为 0（Lv1 起点），实际为 ${String(firstExp)}`,
    )
  }
  for (let i = 1; i < cumulativeExp.length; i += 1) {
    const prev = cumulativeExp[i - 1]
    const curr = cumulativeExp[i]
    if (prev === undefined || curr === undefined) continue
    if (curr <= prev) {
      fail(
        ['global', 'level', 'cumulativeExp', i],
        `等级曲线必须严格递增：Lv${i + 1} 的累计经验 ${curr} 未大于 Lv${i} 的 ${prev}`,
      )
    }
  }
  const maxUnlockLevel = Math.max(...config.zones.zones.map((zone) => zone.unlockLevel))
  if (cumulativeExp.length < maxUnlockLevel) {
    const uncovered = config.zones.zones.filter((zone) => zone.unlockLevel > cumulativeExp.length)
    fail(
      ['global', 'level', 'cumulativeExp'],
      `等级曲线只覆盖到 Lv${cumulativeExp.length}，但 zones.json 里有区域要求更高等级：` +
        uncovered.map((zone) => `「${zone.name}」Lv${zone.unlockLevel}`).join(' / '),
    )
  }

  // ------- 体力：满仓时长必须落在可玩区间，且够跑够新手几趟 -------
  const { maxStamina, staminaRecoverPerMinute, offlineStaminaCapHours } = config.global.player
  const refillMinutes = staminaRefillMinutes(config.global.player)

  if (
    !Number.isFinite(refillMinutes) ||
    refillMinutes < STAMINA_REFILL_MINUTES_MIN ||
    refillMinutes > STAMINA_REFILL_MINUTES_MAX
  ) {
    fail(
      ['global', 'player', 'staminaRecoverPerMinute'],
      `体力满仓需要 ${fmt(refillMinutes)} 分钟（上限 ${maxStamina} ÷ 速率 ${staminaRecoverPerMinute}），` +
        `超出可玩区间 ${STAMINA_REFILL_MINUTES_MIN}–${STAMINA_REFILL_MINUTES_MAX} 分钟：` +
        '低于下限说明体力形同取消，高于上限说明一天玩不到 3 次会话',
    )
  }

  if (offlineStaminaCapHours * 60 < refillMinutes) {
    fail(
      ['global', 'player', 'offlineStaminaCapHours'],
      `离线封顶只有 ${offlineStaminaCapHours} 小时，短于满仓所需的 ${fmt(refillMinutes)} 分钟：玩家睡一觉回来仍然没回满`,
    )
  }

  const startZone = [...config.zones.zones].sort((a, b) => a.unlockLevel - b.unlockLevel)[0]
  if (startZone !== undefined) {
    const tripsPerBar = maxStamina / startZone.staminaCost
    if (tripsPerBar < MIN_TRIPS_PER_STAMINA_BAR) {
      fail(
        ['global', 'player', 'maxStamina'],
        `满仓体力 ${maxStamina} 只够在默认区域「${startZone.name}」跑 ${fmt(tripsPerBar)} 趟（每趟 ${startZone.staminaCost} 点），` +
          `少于 ${MIN_TRIPS_PER_STAMINA_BAR} 趟：新手会被体力卡死`,
      )
    }
  }

  // ------- 物品 -------
  const duplicateItemId = findDuplicate(config.items.items.map((item) => item.id))
  if (duplicateItemId !== null) {
    fail(['items', 'items'], `物品 id 重复："${duplicateItemId}"`)
  }
  config.items.items.forEach((item, index) => {
    item.zones.forEach((zoneRef, zoneIndex) => {
      if (zoneRef !== 'all' && !zoneById.has(zoneRef)) {
        fail(
          ['items', 'items', index, 'zones', zoneIndex],
          `物品「${item.name}」(${item.id}) 引用了不存在的区域 "${zoneRef}"`,
        )
      }
    })
  })

  // ------- 盲盒 -------
  const duplicateBoxId = findDuplicate(config.gacha.boxes.map((box) => box.id))
  if (duplicateBoxId !== null) {
    fail(['gacha', 'boxes'], `盲盒 id 重复："${duplicateBoxId}"`)
  }

  // ------- 保底：计数逐盒配置，因此只能是 per_box 口径 -------
  if (config.gacha.pity.scope !== 'per_box' && config.gacha.boxes.some((box) => box.pityCounter !== null)) {
    fail(
      ['gacha', 'pity', 'scope'],
      '保底计数是逐盒配置的（boxes[].pityCounter），因此 pity.scope 必须是 "per_box"',
    )
  }

  config.gacha.boxes.forEach((box, index) => {
    const base = ['gacha', 'boxes', index] as const
    const sum = sumRates(box.rates)

    if (!nearlyEqual(sum, 1, RATE_TOLERANCE)) {
      fail(
        [...base, 'rates'],
        `盲盒「${box.name}」(${box.id}) 的 rates 概率合计为 ${fmt(sum)}，必须等于 1（容差 ${RATE_TOLERANCE}）`,
      )
      return
    }

    if (box.ratesSum !== undefined && !nearlyEqual(box.ratesSum, sum, RATIO_TOLERANCE)) {
      fail(
        [...base, 'ratesSum'],
        `盲盒「${box.name}」(${box.id}) 的 ratesSum=${box.ratesSum} 与 rates 实际合计 ${fmt(sum)} 不一致`,
      )
    }

    const expectedMaterialValue = RARITY_IDS.reduce(
      (acc, id) => acc + box.rates[id] * (materialValue.get(id) ?? 0),
      0,
    )
    if (
      box.expectedMaterialValue !== undefined &&
      !nearlyEqual(box.expectedMaterialValue, expectedMaterialValue, MONEY_TOLERANCE)
    ) {
      fail(
        [...base, 'expectedMaterialValue'],
        `盲盒「${box.name}」(${box.id}) 的 expectedMaterialValue=${box.expectedMaterialValue} 与重算值 ${fmt(expectedMaterialValue)} 不一致（Σ(概率 × 材料回收价)）`,
      )
    }

    const returnRate = expectedMaterialValue / box.price
    if (box.materialReturnRate !== undefined && !nearlyEqual(box.materialReturnRate, returnRate, RATIO_TOLERANCE)) {
      fail(
        [...base, 'materialReturnRate'],
        `盲盒「${box.name}」(${box.id}) 的 materialReturnRate=${box.materialReturnRate} 与重算值 ${fmt(returnRate)} 不一致（EV ÷ 售价）`,
      )
    }

    // 不变量：材料返还率落在 55%–65%
    if (returnRate < MATERIAL_RETURN_RATE_MIN || returnRate > MATERIAL_RETURN_RATE_MAX) {
      fail(
        [...base, 'materialReturnRate'],
        `盲盒「${box.name}」(${box.id}) 的材料返还率为 ${percent(returnRate)}，` +
          `超出健康区间 ${percent(MATERIAL_RETURN_RATE_MIN)}–${percent(MATERIAL_RETURN_RATE_MAX)}` +
          `（见 CODEBUDDY.md 关键不变量 2：低于 50% 玩家会觉得被坑，高于 70% 玩家就不需要肝了）`,
      )
    }

    const expectedCodexPoints = RARITY_IDS.reduce(
      (acc, id) => acc + box.rates[id] * (codexPoints.get(id) ?? 0),
      0,
    )
    if (
      box.expectedCodexPoints !== undefined &&
      !nearlyEqual(box.expectedCodexPoints, expectedCodexPoints, MONEY_TOLERANCE)
    ) {
      fail(
        [...base, 'expectedCodexPoints'],
        `盲盒「${box.name}」(${box.id}) 的 expectedCodexPoints=${box.expectedCodexPoints} 与重算值 ${fmt(expectedCodexPoints)} 不一致（Σ(概率 × 图鉴点)）`,
      )
    }

    // ------- 保底：含保底的实测返还率同样必须落在 55%–65% -------
    const targetRarity = config.gacha.pity.targetRarity
    const withPity = expectedReturnRateWithPity(box, materialValue, targetRarity)

    if (box.pityCounter !== null && rateAtLeast(box.rates, targetRarity) <= 0) {
      fail(
        [...base, 'pityCounter'],
        `盲盒「${box.name}」(${box.id}) 设了 pityCounter=${box.pityCounter}，` +
          `但「${targetRarity}」及以上的概率合计为 0，保底无法执行`,
      )
    }

    if (box.returnRateWithPity !== undefined && !nearlyEqual(box.returnRateWithPity, withPity, RATIO_TOLERANCE)) {
      fail(
        [...base, 'returnRateWithPity'],
        `盲盒「${box.name}」(${box.id}) 的 returnRateWithPity=${box.returnRateWithPity} 与重算值 ${fmt(withPity)} 不一致（含保底的解析解）`,
      )
    }

    if (withPity < MATERIAL_RETURN_RATE_MIN || withPity > MATERIAL_RETURN_RATE_MAX) {
      fail(
        [...base, 'pityCounter'],
        `盲盒「${box.name}」(${box.id}) 含保底（pityCounter=${String(box.pityCounter)}）后的实测返还率为 ${percent(withPity)}，` +
          `超出 ${percent(MATERIAL_RETURN_RATE_MIN)}–${percent(MATERIAL_RETURN_RATE_MAX)}：保底那一次的收入超过了凑够保底的累计成本，` +
          '玩家会只买保底刷钱（材料可卖成钱）。请调大该盒的 pityCounter 或调低其紫金概率',
      )
    }
  })

  // ------- 载具 -------
  const vehicles = config.vehicles.vehicles
  const vehicleIds = vehicles.map((vehicle) => vehicle.id)

  const duplicateVehicleId = findDuplicate(vehicleIds)
  if (duplicateVehicleId !== null) {
    fail(['vehicles', 'vehicles'], `载具 id 重复："${duplicateVehicleId}"`)
  }

  const firstVehicle = vehicles[0]
  if (firstVehicle !== undefined && firstVehicle.upgradeCostFromPrev !== 0) {
    fail(
      ['vehicles', 'vehicles', 0, 'upgradeCostFromPrev'],
      `初始载具「${firstVehicle.name}」(${firstVehicle.id}) 的 upgradeCostFromPrev 必须为 0`,
    )
  }

  vehicles.forEach((vehicle, index) => {
    if (!zoneById.has(vehicle.referenceZone)) {
      fail(
        ['vehicles', 'vehicles', index, 'referenceZone'],
        `载具「${vehicle.name}」(${vehicle.id}) 引用了不存在的区域 "${vehicle.referenceZone}"`,
      )
    }
  })

  for (let i = 1; i < vehicles.length; i += 1) {
    const prev = vehicles[i - 1]
    const curr = vehicles[i]
    if (prev === undefined || curr === undefined) continue
    if (curr.grids <= prev.grids) {
      fail(
        ['vehicles', 'vehicles', i, 'grids'],
        `载具「${curr.name}」(${curr.id}) 的格数 ${curr.grids} 必须大于上一级「${prev.name}」的 ${prev.grids}`,
      )
    }
    if (curr.upgradeCostFromPrev <= prev.upgradeCostFromPrev) {
      fail(
        ['vehicles', 'vehicles', i, 'upgradeCostFromPrev'],
        `载具「${curr.name}」(${curr.id}) 的升级成本 ${curr.upgradeCostFromPrev} 必须大于上一级「${prev.name}」的 ${prev.upgradeCostFromPrev}`,
      )
    }
  }

  if (!vehicleIds.includes(config.global.player.initialVehicle)) {
    fail(
      ['global', 'player', 'initialVehicle'],
      `global.player.initialVehicle="${config.global.player.initialVehicle}" 不在 vehicles.json 的载具列表中（可选值：${vehicleIds.join(' / ')}）`,
    )
  }

  config.vehicles.upgradeCheckpoints.forEach((checkpoint, index) => {
    const base = ['vehicles', 'upgradeCheckpoints', index] as const
    const targetIndex = vehicleIds.indexOf(checkpoint.to)
    if (targetIndex < 1) {
      fail(
        [...base, 'to'],
        `upgradeCheckpoints[${index}] 的 to="${checkpoint.to}" 不是合法的目标载具（必须是除初始载具外的载具 id）`,
      )
      return
    }
    const prevVehicle = vehicles[targetIndex - 1]
    const currVehicle = vehicles[targetIndex]
    if (prevVehicle === undefined || currVehicle === undefined) return
    const prevZone = zoneById.get(prevVehicle.referenceZone)
    const currZone = zoneById.get(currVehicle.referenceZone)
    if (prevZone === undefined || currZone === undefined) return

    const beforeRevenue = prevVehicle.grids * zoneAvgUnitValue(prevZone, streetAvgValue)
    const afterRevenue = currVehicle.grids * zoneAvgUnitValue(currZone, streetAvgValue)
    const saveUpTrips = currVehicle.upgradeCostFromPrev / beforeRevenue
    const paybackTrips = currVehicle.upgradeCostFromPrev / afterRevenue

    if (
      checkpoint.beforeTripRevenue !== undefined &&
      !nearlyEqual(checkpoint.beforeTripRevenue, beforeRevenue, MONEY_TOLERANCE)
    ) {
      fail(
        [...base, 'beforeTripRevenue'],
        `升级「${currVehicle.name}」的 beforeTripRevenue=${checkpoint.beforeTripRevenue} 与重算值 ${fmt(beforeRevenue)} 不一致（升级前格数 × 升级前区域平均单件价值）`,
      )
    }
    if (
      checkpoint.afterTripRevenue !== undefined &&
      !nearlyEqual(checkpoint.afterTripRevenue, afterRevenue, MONEY_TOLERANCE)
    ) {
      fail(
        [...base, 'afterTripRevenue'],
        `升级「${currVehicle.name}」的 afterTripRevenue=${checkpoint.afterTripRevenue} 与重算值 ${fmt(afterRevenue)} 不一致（升级后格数 × 升级后区域平均单件价值）`,
      )
    }
    if (checkpoint.saveUpTrips !== undefined && !nearlyEqual(checkpoint.saveUpTrips, saveUpTrips, TRIPS_TOLERANCE)) {
      fail(
        [...base, 'saveUpTrips'],
        `升级「${currVehicle.name}」的 saveUpTrips=${checkpoint.saveUpTrips} 与重算值 ${fmt(saveUpTrips)} 不一致（升级成本 ÷ 升级前单趟收益）`,
      )
    }
    if (checkpoint.paybackTrips !== undefined && !nearlyEqual(checkpoint.paybackTrips, paybackTrips, TRIPS_TOLERANCE)) {
      fail(
        [...base, 'paybackTrips'],
        `升级「${currVehicle.name}」的 paybackTrips=${checkpoint.paybackTrips} 与重算值 ${fmt(paybackTrips)} 不一致（升级成本 ÷ 升级后单趟收益）`,
      )
    }

    // 不变量：攒钱趟数落在 8–18 趟
    if (saveUpTrips < SAVE_UP_TRIPS_MIN || saveUpTrips > SAVE_UP_TRIPS_MAX) {
      fail(
        [...base, 'saveUpTrips'],
        `升级到「${currVehicle.name}」(${currVehicle.id}) 的攒钱趟数为 ${fmt(saveUpTrips)}，` +
          `落在 ${SAVE_UP_TRIPS_MIN}–${SAVE_UP_TRIPS_MAX} 趟之外（见 CODEBUDDY.md 关键不变量 6：低于 5 趟升级没成就感，高于 25 趟会劝退）`,
      )
    }
  })
})

export type GameConfig = z.infer<typeof gameConfigSchema>
