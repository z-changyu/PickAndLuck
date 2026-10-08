/**
 * 种子随机 —— 本工程唯一允许的随机来源。
 *
 * 为什么不用 Math.random()：
 *   线上出现数值 bug 时必须能用「同一个 seed + 同一串操作」复现问题；
 *   Math.random() 既无法复现，也无法写单测（见 CODEBUDDY.md 关键约束 3）。
 *
 * 算法：mulberry32。纯 32 位整数运算（Math.imul + 位移），
 * 因此在浏览器、Node、以及阶段二 Cocos 的 JS 运行时里序列完全一致。
 */

/** mulberry32 的 32 位状态增量（算法常量，与游戏数值无关） */
const STATE_INCREMENT = 0x6d2b79f5
/** 2^32，把 32 位无符号整数映射到 [0, 1) */
const UINT32_RANGE = 4_294_967_296

export interface Rng {
  /** [0, 1) 均匀分布 */
  next(): number
  /** [min, max] 闭区间随机整数 */
  int(min: number, max: number): number
  /** 从非空列表中等概率取一个 */
  pick<T>(list: readonly T[]): T
  /** 按权重返回下标；权重不必归一化，但必须非负且合计 > 0 */
  weightedIndex(weights: readonly number[]): number
  /**
   * 以 probability 的概率返回 true。
   * 注意：p ≤ 0 / p ≥ 1 时直接返回且**不消耗**随机数，
   * 因此假点率为 0 的区域不会因判定而改变后续序列。
   */
  chance(probability: number): boolean
  /** 当前内部状态，可用于存档与回放 */
  readonly state: number
}

function buildRng(initialState: number): Rng {
  let state = initialState

  const next = (): number => {
    state = (state + STATE_INCREMENT) >>> 0
    let x = Math.imul(state ^ (state >>> 15), 1 | state)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / UINT32_RANGE
  }

  const weightedIndex = (weights: readonly number[]): number => {
    if (weights.length === 0) throw new Error('weightedIndex: 权重列表不能为空')
    let total = 0
    for (const weight of weights) {
      if (!Number.isFinite(weight) || weight < 0) {
        throw new Error(`weightedIndex: 权重必须是非负有限数，收到 ${String(weight)}`)
      }
      total += weight
    }
    if (total <= 0) throw new Error('weightedIndex: 权重合计必须大于 0')

    let roll = next() * total
    for (let index = 0; index < weights.length; index += 1) {
      roll -= weights[index] ?? 0
      if (roll < 0) return index
    }
    // 浮点误差兜底：落到最后一档
    return weights.length - 1
  }

  return {
    next,
    int: (min, max) => {
      if (!Number.isInteger(min) || !Number.isInteger(max)) {
        throw new Error(`int: 边界必须是整数，收到 ${String(min)} / ${String(max)}`)
      }
      if (max < min) throw new Error(`int: max(${max}) 不能小于 min(${min})`)
      return min + Math.floor(next() * (max - min + 1))
    },
    pick: (list) => {
      if (list.length === 0) throw new Error('pick: 列表不能为空')
      const value = list[Math.floor(next() * list.length)]
      if (value === undefined) throw new Error('pick: 索引越界')
      return value
    },
    weightedIndex,
    chance: (probability) => {
      if (probability <= 0) return false
      if (probability >= 1) return true
      return next() < probability
    },
    get state() {
      return state
    },
  }
}

/** 种子入口：新建一串随机序列 */
export function createRng(seed: number): Rng {
  if (!Number.isFinite(seed)) throw new Error(`createRng: seed 必须是有限数，收到 ${String(seed)}`)
  return buildRng(seed >>> 0)
}

/**
 * 存档状态入口：从「已经推进过的内部状态」恢复随机序列。
 *
 * 种子只确定起点；读档要接上存档那一刻的状态，才能继续复现同一串随机数
 * （调试面板「用同一 seed 重放某一趟」依赖这一点）。
 */
export function createRngFromState(state: number): Rng {
  if (!Number.isInteger(state) || state < 0) {
    throw new Error(`createRngFromState: state 必须是非负整数，收到 ${String(state)}`)
  }
  return buildRng(state >>> 0)
}
