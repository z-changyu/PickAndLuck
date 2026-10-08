import { describe, expect, it } from 'vitest'

import { loadConfig } from '../../src/config/loader'
import {
  MATERIAL_RETURN_RATE_MAX,
  MATERIAL_RETURN_RATE_MIN,
  RARITY_IDS,
  expectedReturnRateWithPity,
} from '../../src/config/schema'
import type { RarityId } from '../../src/config/schema'
import { createGachaState, openBox, rateTable, rollBoxRarity, shardExchangeOptions } from '../../src/core/gacha'
import type { GachaState, OpenBoxResult } from '../../src/core/gacha'
import { createRng } from '../../src/core/rng'

const config = loadConfig()
const BOX = 'junk_box'
const rarityRank = (rarity: RarityId): number => RARITY_IDS.indexOf(rarity)

/** 图鉴池尚未接入（属 T7），这里按稀有度归一作为 rewardId */
const picker = (boxId: string, rarity: RarityId): string => `${boxId}:${rarity}`

const open = (rng: ReturnType<typeof createRng>, state: GachaState): OpenBoxResult =>
  openBox(rng, config, state, BOX, picker)

const boxOf = (boxId: string) => {
  const box = config.gacha.boxes.find((candidate) => candidate.id === boxId)
  if (box === undefined) throw new Error(`测试数据缺少盲盒 ${boxId}`)
  return box
}

describe('gacha · 可复现（同一 seed 产出序列完全一致）', () => {
  const run = (): OpenBoxResult[] => {
    const rng = createRng(20261008)
    let state = createGachaState()
    const log: OpenBoxResult[] = []
    for (let i = 0; i < 200; i += 1) {
      const result = open(rng, state)
      log.push(result)
      state = result.state
    }
    return log
  }

  it('同一 seed + 同一初始状态 → 产出与状态逐件相同', () => {
    expect(run()).toEqual(run())
  })

  it('不同 seed 产出不同', () => {
    const withSeed = (seed: number) => {
      const rng = createRng(seed)
      let state = createGachaState()
      return Array.from({ length: 50 }, () => {
        const result = open(rng, state)
        state = result.state
        return result.rarity
      })
    }
    expect(withSeed(1)).not.toEqual(withSeed(2))
  })
})

describe('gacha · 新手首抽保护（首次开箱稀有度 ≥ 蓝）', () => {
  it('首抽达到下限档，且原因标记为 new_player', () => {
    const result = open(createRng(1), createGachaState())

    expect(result.reason).toBe('new_player')
    expect(rarityRank(result.rarity)).toBeGreaterThanOrEqual(
      rarityRank(config.gacha.pity.newPlayerFirstPullMinRarity),
    )
  })

  it('首抽之后不再受保护（正常概率下会出现白档）', () => {
    const rng = createRng(2)
    let state = createGachaState()
    let sawWhite = false
    for (let i = 0; i < 200 && !sawWhite; i += 1) {
      const result = open(rng, state)
      state = result.state
      if (result.rarity === 'white') sawWhite = true
    }
    expect(sawWhite).toBe(true)
  })
})

describe('gacha · 保底（逐盒计数：连续 pityCounter 次未出目标档则下一抽必出）', () => {
  const box = boxOf(BOX)
  const guarantee = box.pityCounter ?? 0
  const target = config.gacha.pity.targetRarity

  it('计数到达上限前一拍时，下一抽必为目标档以上并清空计数', () => {
    const state: GachaState = {
      ...createGachaState(),
      openCount: 1,
      pityCounters: { [BOX]: guarantee - 1 },
    }
    const result = open(createRng(5), state)

    expect(rarityRank(result.rarity)).toBeGreaterThanOrEqual(rarityRank(target))
    expect(result.reason).toBe('pity')
    expect(result.state.pityCounters[BOX]).toBe(0)
    expect(result.state.openCount).toBe(2)
  })

  it('连续 20000 抽中，任何时刻都不会出现「连续 guarantee 次未出目标档」', () => {
    const rng = createRng(20261008)
    let state = createGachaState()
    let streak = 0

    for (let i = 0; i < 20000; i += 1) {
      const result = open(rng, state)
      state = result.state
      streak = rarityRank(result.rarity) >= rarityRank(target) ? 0 : streak + 1
      expect(streak, `第 ${i + 1} 抽后连续未出目标档次数`).toBeLessThan(guarantee)
    }
  })

  it('取出目标档后计数清零（resetOnHit = true）', () => {
    const state: GachaState = { ...createGachaState(), openCount: 1, pityCounters: { [BOX]: 3 } }
    const result = open(createRng(3), state)

    const expected = rarityRank(result.rarity) >= rarityRank(target) ? 0 : 4
    expect(result.state.pityCounters[BOX]).toBe(expected)
  })

  it('各盒的保底计数互不影响（per_box）', () => {
    const rng = createRng(13)
    const state: GachaState = { ...createGachaState(), openCount: 5, pityCounters: { [BOX]: guarantee - 1 } }

    const result = openBox(rng, config, state, 'antique_box', picker)
    const isHit = rarityRank(result.rarity) >= rarityRank(config.gacha.pity.targetRarity)

    expect(result.state.pityCounters[BOX], '别的盒子计数不受影响').toBe(guarantee - 1)
    expect(result.state.pityCounters['antique_box']).toBe(isHit ? 0 : 1)
  })
})

describe('gacha · 重复转碎片', () => {
  it('首次记入图鉴并给图鉴点；重复则转碎片且不再加图鉴点', () => {
    const rng = createRng(11)
    const convert = config.gacha.duplicateConvert

    const first = open(rng, createGachaState())
    expect(first.duplicate).toBe(false)
    expect(first.shardsGained).toBe(0)
    expect(first.codexPoints).toBeGreaterThan(0)
    expect(first.state.owned).toContain(first.rewardId)

    // 固定 picker 让第二次一定撞上同一个 rewardId
    const again = openBox(rng, config, first.state, BOX, () => first.rewardId)
    expect(again.duplicate).toBe(true)
    expect(again.shardsGained).toBe(convert.shardPerRarity[again.rarity])
    expect(again.codexPoints).toBe(0)
    expect(again.state.shards).toBe(convert.shardPerRarity[again.rarity])
    expect(again.state.owned).toEqual(first.state.owned)
  })
})

describe('gacha · 材料价值与图鉴点来自 rarity.json', () => {
  it('每抽的材料价值 = 该档 materialValue', () => {
    const rng = createRng(7)
    let state = createGachaState()

    for (let i = 0; i < 50; i += 1) {
      const result = open(rng, state)
      const entry = config.rarity.rarities.find((item) => item.id === result.rarity)
      expect(entry, `稀有度 ${result.rarity}`).toBeDefined()
      expect(result.materialValue).toBe(entry?.materialValue)
      state = result.state
    }
  })
})

describe('gacha · 概率公示数据（购买前可查完整概率）', () => {
  it('每款盲盒的公示表合计 = 1 且与 config 的 rates 逐档一致', () => {
    for (const box of config.gacha.boxes) {
      const rows = rateTable(config, box.id)

      expect(rows).toHaveLength(RARITY_IDS.length)
      expect(rows.reduce((total, row) => total + row.rate, 0), box.name).toBeCloseTo(1, 6)
      for (const row of rows) expect(row.rate, `${box.name} ${row.rarity}`).toBe(box.rates[row.rarity])
    }
  })

  it('碎片兑换表直接来自配置', () => {
    expect(shardExchangeOptions(config)).toEqual(config.gacha.duplicateConvert.shardExchange)
  })

  it('未知盲盒抛错', () => {
    expect(() => rateTable(config, 'atlantis')).toThrow(/atlantis/)
    expect(() => rollBoxRarity(createRng(1), config, 'atlantis')).toThrow(/atlantis/)
  })
})

describe('gacha · 材料返还率（T4 验收）', () => {
  it('按盒概率直接采样 10000 次：实测返还率 ≈ 0.631 ± 0.02', () => {
    const box = boxOf(BOX)
    const rng = createRng(20261008)
    const samples = 10000

    let value = 0
    for (let i = 0; i < samples; i += 1) {
      const rarity = rollBoxRarity(rng, config, BOX)
      value += config.rarity.rarities.find((item) => item.id === rarity)?.materialValue ?? 0
    }

    const declared = box.materialReturnRate
    expect(declared).toBeDefined()
    if (declared === undefined) return

    expect(Math.abs(value / (samples * box.price) - declared)).toBeLessThan(0.02)
  })

  it('含保底：解析解落在 0.55–0.65，且实测与解析解一致', () => {
    const box = boxOf(BOX)
    const rng = createRng(20261008)
    const samples = 20000

    let state = createGachaState()
    let value = 0
    for (let i = 0; i < samples; i += 1) {
      const result = open(rng, state)
      value += result.materialValue
      state = result.state
    }
    const realized = value / (samples * box.price)

    const analytic = box.returnRateWithPity
    expect(analytic).toBeDefined()
    if (analytic === undefined) return

    // 区间约束施加在解析解上（与 check-config 同源，完全确定）；
    // 实测值只与解析解比，容差 0.015 覆盖保底周期长、方差大的蒙特卡洛波动。
    expect(analytic, '解析解').toBeGreaterThanOrEqual(MATERIAL_RETURN_RATE_MIN)
    expect(analytic, '解析解').toBeLessThanOrEqual(MATERIAL_RETURN_RATE_MAX)
    expect(Math.abs(realized - analytic), `实测 ${realized.toFixed(4)} vs 解析 ${analytic.toFixed(4)}`).toBeLessThan(
      0.015,
    )
  })

  it('每款盲盒的含保底返还率都在 0.55–0.65（逐盒保底的核心不变量）', () => {
    const materialValue = new Map<RarityId, number>(
      config.rarity.rarities.map((rarity) => [rarity.id, rarity.materialValue]),
    )

    for (const box of config.gacha.boxes) {
      const withPity = expectedReturnRateWithPity(box, materialValue, config.gacha.pity.targetRarity)
      expect(withPity, `${box.name} 含保底返还率`).toBeGreaterThanOrEqual(MATERIAL_RETURN_RATE_MIN)
      expect(withPity, `${box.name} 含保底返还率`).toBeLessThanOrEqual(MATERIAL_RETURN_RATE_MAX)
    }
  })
})
