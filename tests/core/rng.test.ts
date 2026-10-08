import { describe, expect, it } from 'vitest'

import { createRng } from '../../src/core/rng'

const take = (seed: number, count: number): number[] => {
  const rng = createRng(seed)
  return Array.from({ length: count }, () => rng.next())
}

describe('rng · 可复现性（关键约束 3）', () => {
  it('同一 seed 的两个实例序列逐位相同', () => {
    expect(take(20261008, 50)).toEqual(take(20261008, 50))
  })

  it('不同 seed 序列不同', () => {
    expect(take(1, 20)).not.toEqual(take(2, 20))
  })

  it('next() 恒落在 [0, 1)', () => {
    const rng = createRng(7)
    for (let i = 0; i < 1000; i += 1) {
      const value = rng.next()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })

  it('状态随取值推进（供存档 / 回放使用）', () => {
    const rng = createRng(42)
    const before = rng.state
    rng.next()
    expect(rng.state).not.toBe(before)
  })
})

describe('rng · int / pick / chance', () => {
  it('int 是闭区间且只返回整数', () => {
    const rng = createRng(99)
    const seen = new Set<number>()
    for (let i = 0; i < 2000; i += 1) {
      const value = rng.int(3, 6)
      expect(Number.isInteger(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(3)
      expect(value).toBeLessThanOrEqual(6)
      seen.add(value)
    }
    expect([...seen].sort()).toEqual([3, 4, 5, 6])
  })

  it('int(5, 5) 恒等于 5', () => {
    const rng = createRng(1)
    for (let i = 0; i < 10; i += 1) expect(rng.int(5, 5)).toBe(5)
  })

  it('pick 能覆盖整个列表', () => {
    const rng = createRng(2026)
    const seen = new Set<string>()
    for (let i = 0; i < 500; i += 1) seen.add(rng.pick(['a', 'b', 'c']))
    expect([...seen].sort()).toEqual(['a', 'b', 'c'])
  })

  it('chance(0) / chance(1) 是确定的短路值', () => {
    const rng = createRng(3)
    for (let i = 0; i < 50; i += 1) {
      expect(rng.chance(0)).toBe(false)
      expect(rng.chance(1)).toBe(true)
    }
  })

  it('chance(p) 的命中率贴近 p', () => {
    const rng = createRng(12345)
    const samples = 20000
    let hits = 0
    for (let i = 0; i < samples; i += 1) if (rng.chance(0.35)) hits += 1
    expect(Math.abs(hits / samples - 0.35)).toBeLessThan(0.015)
  })

  it('weightedIndex 的分布与权重成比例', () => {
    const rng = createRng(555)
    const samples = 20000
    const counts = [0, 0, 0]
    for (let i = 0; i < samples; i += 1) {
      const index = rng.weightedIndex([0.5, 0.35, 0.15])
      counts[index] = (counts[index] ?? 0) + 1
    }
    expect(Math.abs((counts[0] ?? 0) / samples - 0.5)).toBeLessThan(0.02)
    expect(Math.abs((counts[1] ?? 0) / samples - 0.35)).toBeLessThan(0.02)
    expect(Math.abs((counts[2] ?? 0) / samples - 0.15)).toBeLessThan(0.02)
  })
})

describe('rng · 参数校验（坏输入必须立刻报错，不能静默）', () => {
  it('空列表 / 空权重 / 负权重 / 非法边界都会抛错', () => {
    const rng = createRng(1)
    expect(() => rng.pick([])).toThrow()
    expect(() => rng.weightedIndex([])).toThrow()
    expect(() => rng.weightedIndex([1, -1])).toThrow()
    expect(() => rng.weightedIndex([0, 0])).toThrow()
    expect(() => rng.int(3, 2)).toThrow()
    expect(() => rng.int(0.5, 2)).toThrow()
  })

  it('createRng 拒绝非有限 seed', () => {
    expect(() => createRng(Number.NaN)).toThrow()
    expect(() => createRng(Number.POSITIVE_INFINITY)).toThrow()
  })
})
