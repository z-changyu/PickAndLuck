import type { FrozenGameConfig } from '../config/loader'
import { RARITY_IDS, findBox, findRarity } from '../config/schema'
import type { RarityId } from '../config/schema'
import type { Rng } from './rng'

/**
 * 盲盒开箱：按概率 roll → 保底 → 新手首抽保护 → 重复转碎片。
 *
 * 三条与 config/gacha.json 的对应关系：
 *   · 概率    box.rates（含保底/保护时的抬升口径见下方注释）
 *   · 保底    box.pityCounter（逐盒）+ pity.targetRarity / scope / resetOnHit
 *   · 碎片    duplicateConvert.shardPerRarity
 *
 * 保底与新手保护都采用「在允许的档位里按原概率重新归一化抽取」，
 * 而不是把低档的概率整块堆到目标档上 —— 前者不会凭空放大目标档概率，
 * 与策划案「公示要真」的底线一致（公示表因此仍等于 box.rates）。
 *
 * 藏品身份（rewardId）由调用方通过 RewardPicker 注入：图鉴池属于 T7 的配置范围，
 * 在池子接入之前，测试与调试面板可以按稀有度归一。
 */

/** 一次开箱的来源标记（供 UI 说明「本次为保底 / 新手保护」） */
export const DRAW_REASONS = ['normal', 'pity', 'new_player'] as const
export type DrawReason = (typeof DRAW_REASONS)[number]

/** 可存档的开箱状态（纯数据，直接 JSON.stringify 即可落盘） */
export interface GachaState {
  /** 保底计数：scope=per_box 时按盲盒 id 分桶，global 时统一用 "*" */
  readonly pityCounters: Readonly<Record<string, number>>
  /** 累计开箱次数（判定新手首抽保护） */
  readonly openCount: number
  /** 已拥有的藏品 id（图鉴） */
  readonly owned: readonly string[]
  readonly shards: number
}

export const createGachaState = (): GachaState => ({ pityCounters: {}, openCount: 0, owned: [], shards: 0 })

/** 图鉴池：由 (盲盒, 稀有度) 决定藏品身份；T7 接入真实池子 */
export type RewardPicker = (boxId: string, rarity: RarityId) => string

export interface OpenBoxResult {
  readonly boxId: string
  readonly rarity: RarityId
  readonly rewardId: string
  readonly reason: DrawReason
  /** 该档材料可卖出的价值（rarity.json → materialValue） */
  readonly materialValue: number
  /** 新藏品贡献的图鉴点；重复时不加图鉴点，改为给碎片 */
  readonly codexPoints: number
  readonly duplicate: boolean
  readonly shardsGained: number
  readonly state: GachaState
}

const rarityRank = (rarity: RarityId): number => RARITY_IDS.indexOf(rarity)

/** 按盲盒概率抽一档（不含保底与新手保护；概率公示与回归测试用同一实现） */
export function rollBoxRarity(rng: Rng, config: FrozenGameConfig, boxId: string): RarityId {
  const box = findBox(config.gacha.boxes, boxId)
  const index = rng.weightedIndex(RARITY_IDS.map((rarity) => box.rates[rarity]))
  const rarity = RARITY_IDS[index]
  if (rarity === undefined) throw new Error(`rollBoxRarity: 权重下标 ${index} 越界`)
  return rarity
}

/** 在 ≥ minRarity 的档位里，按原概率重新归一化抽一档（保底与新手保护共用） */
export function rollBoxRarityAtLeast(
  rng: Rng,
  config: FrozenGameConfig,
  boxId: string,
  minRarity: RarityId,
): RarityId {
  const box = findBox(config.gacha.boxes, boxId)
  const minRank = rarityRank(minRarity)
  const weights = RARITY_IDS.map((rarity, rank) => (rank >= minRank ? box.rates[rarity] : 0))

  const total = weights.reduce((sum, weight) => sum + weight, 0)
  if (total <= 0) {
    throw new Error(
      `盲盒「${box.name}」(${box.id}) 在「${minRarity}」及以上的概率合计为 0，无法执行保底 / 新手保护` +
        '（config/gacha.json 的 rates 配置有误）',
    )
  }

  const index = rng.weightedIndex(weights)
  const rarity = RARITY_IDS[index]
  if (rarity === undefined) throw new Error(`rollBoxRarityAtLeast: 权重下标 ${index} 越界`)
  return rarity
}

const pityKeyOf = (scope: 'per_box' | 'global', boxId: string): string => (scope === 'global' ? '*' : boxId)

/** 开一次盲盒；返回结果与推进后的状态（原状态不被修改） */
export function openBox(
  rng: Rng,
  config: FrozenGameConfig,
  state: GachaState,
  boxId: string,
  pickReward: RewardPicker,
): OpenBoxResult {
  const box = findBox(config.gacha.boxes, boxId)
  const { pity, duplicateConvert } = config.gacha
  const key = pityKeyOf(pity.scope, box.id)
  const counter = state.pityCounters[key] ?? 0
  const guarantee = box.pityCounter

  let rarity: RarityId
  let reason: DrawReason

  if (guarantee !== null && counter >= guarantee - 1) {
    rarity = rollBoxRarityAtLeast(rng, config, box.id, pity.targetRarity)
    reason = 'pity'
  } else if (state.openCount === 0) {
    rarity = rollBoxRarityAtLeast(rng, config, box.id, pity.newPlayerFirstPullMinRarity)
    reason = 'new_player'
  } else {
    rarity = rollBoxRarity(rng, config, box.id)
    reason = 'normal'
  }

  const rarityEntry = findRarity(config.rarity.rarities, rarity)
  const rewardId = pickReward(box.id, rarity)
  const duplicate = duplicateConvert.enabled && state.owned.includes(rewardId)
  const shardsGained = duplicate ? duplicateConvert.shardPerRarity[rarity] : 0

  const hitTarget = rarityRank(rarity) >= rarityRank(pity.targetRarity)
  const nextCounter = hitTarget && pity.resetOnHit ? 0 : counter + 1
  const cappedCounter = guarantee === null ? nextCounter : Math.min(nextCounter, guarantee)

  return {
    boxId: box.id,
    rarity,
    rewardId,
    reason,
    materialValue: rarityEntry.materialValue,
    codexPoints: duplicate ? 0 : rarityEntry.codexPoints,
    duplicate,
    shardsGained,
    state: {
      pityCounters: { ...state.pityCounters, [key]: cappedCounter },
      openCount: state.openCount + 1,
      owned: duplicate ? state.owned : [...state.owned, rewardId],
      shards: state.shards + shardsGained,
    },
  }
}

export interface BoxRateRow {
  readonly rarity: RarityId
  readonly rate: number
  readonly materialValue: number
  readonly codexPoints: number
}

/** 概率公示数据：购买前必须能查到完整概率（T7 的「概率公示页」直接用这份） */
export function rateTable(config: FrozenGameConfig, boxId: string): BoxRateRow[] {
  const box = findBox(config.gacha.boxes, boxId)
  return RARITY_IDS.map((rarity) => {
    const entry = findRarity(config.rarity.rarities, rarity)
    return { rarity, rate: box.rates[rarity], materialValue: entry.materialValue, codexPoints: entry.codexPoints }
  })
}

/** 碎片兑换表（T7 碎片入口直接用这份） */
export const shardExchangeOptions = (config: FrozenGameConfig) => config.gacha.duplicateConvert.shardExchange
