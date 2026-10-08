import { z } from 'zod'

import type { FrozenGameConfig } from '../config/loader'
import { CONDITION_IDS } from '../config/schema'
import { createGachaState } from './gacha'
import type { GachaState } from './gacha'
import { capacityOf, createInventory } from './inventory'
import type { Inventory } from './inventory'
import type { PickedItem } from './pickup'
import { defaultZone, isZoneUnlocked, levelFromExp, staminaAfterOffline } from './progression'
import { createRng, createRngFromState } from './rng'
import type { Rng } from './rng'

/**
 * 存档：序列化 / 反序列化 / 版本迁移 / 读档修复。
 *
 * 纯逻辑，不碰 localStorage / wx.setStorage —— 落盘由 render（阶段一）与平台层（阶段二）负责。
 * 这样单测能直接把存档跑一遍，换引擎也不用动这里。
 *
 * 三条设计原则：
 *   1. **只存「玩家做了什么」，不存「配置推出来的东西」**：
 *      背包容量 = 载具格数 + 扩容格数、等级 = f(经验)、已解锁区域 = g(等级)
 *      都不落盘，读档时用当前配置重算 —— 否则策划改平衡后，老存档会卡在旧数值上。
 *   2. **物品按 id 存**（不存单价/重量/占格）：读档时到当前 config 里取回，
 *      于是调价、改品相系数会立刻作用于所有玩家。
 *   3. **坏数据宁可报错也不静默**：结构不对抛 SaveError；
 *      能就地修的（载具被删、区域没解锁、物品没了、体力超上限）修好并记进 repairs。
 */

/** 当前存档版本；改动结构时 +1，并在 MIGRATIONS 里补一步迁移 */
export const SAVE_VERSION = 1

/** 存档相关的错误（与配置错误区分开，便于上层分别提示） */
export class SaveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SaveError'
  }
}

export interface SavePlayer {
  readonly money: number
  readonly stamina: number
  readonly vehicleId: string
  /** 背包扩容次数（容量 = 载具格数 + 次数 × 每次格数） */
  readonly gridExpansions: number
  /** 累计经验（等级由它推出来） */
  readonly exp: number
  /** 当前所在区域 */
  readonly zoneId: string
}

export interface SaveStats {
  /** 累计完成趟数 */
  readonly trips: number
  /** 累计出售额（周榜「本周拾荒王」按它排名） */
  readonly earnedTotal: number
}

export interface GameSave {
  readonly player: SavePlayer
  readonly rng: { readonly seed: number; readonly state: number }
  readonly inventory: Inventory
  readonly gacha: GachaState
  readonly stats: SaveStats
}

export interface ParseSaveResult {
  readonly save: GameSave
  /** 存档落盘时间；离线体力结算（applyOfflineStamina）要用它 */
  readonly savedAt: number
  /** 读档时就地修复的内容（配置调过、物品被删…）；空数组表示原样读回 */
  readonly repairs: readonly string[]
}

// ---------------------------------------------------------------- 线上格式（wire）

const envelopeHeaderSchema = z.object({
  version: z.number().int().nonnegative(),
  savedAt: z.number().int().nonnegative(),
  game: z.unknown(),
})

const saveGameSchema = z.object({
  player: z.object({
    money: z.number().nonnegative(),
    stamina: z.number().nonnegative(),
    vehicleId: z.string().min(1),
    gridExpansions: z.number().int().nonnegative(),
    exp: z.number().nonnegative(),
    zoneId: z.string().min(1),
  }),
  rng: z.object({
    seed: z.number().int(),
    state: z.number().int().nonnegative(),
  }),
  inventory: z.array(
    z.object({
      id: z.string().min(1),
      condition: z.enum(CONDITION_IDS),
    }),
  ),
  gacha: z.object({
    pityCounters: z.record(z.string(), z.number().int().nonnegative()),
    openCount: z.number().int().nonnegative(),
    owned: z.array(z.string().min(1)),
    shards: z.number().nonnegative(),
  }),
  stats: z.object({
    trips: z.number().int().nonnegative(),
    earnedTotal: z.number().nonnegative(),
  }),
})

type SaveGameWire = z.infer<typeof saveGameSchema>

/**
 * 版本迁移表：MIGRATIONS[n] 负责把第 n 版升到第 n+1 版。
 * 当前 SAVE_VERSION = 1，所以表是空的；将来加字段时在这里补一步、
 * 并把 SAVE_VERSION +1（老存档因此能平滑升级，而不是报错或被静默误读）。
 */
const MIGRATIONS: Record<number, (game: unknown) => unknown> = {
  // 1: (game) => ({ ...(game as Record<string, unknown>), newField: defaultValue }),
}

// ---------------------------------------------------------------- 新建 / 序列化

/** 开新档：所有初值都来自 config（含随机种子） */
export function createNewGame(config: FrozenGameConfig): GameSave {
  const { player } = config.global
  const rng = createRng(config.global.debug.rngSeed)

  return {
    player: {
      money: player.initialMoney,
      stamina: player.initialStamina,
      vehicleId: player.initialVehicle,
      gridExpansions: 0,
      exp: 0,
      zoneId: defaultZone(config).id,
    },
    rng: { seed: config.global.debug.rngSeed, state: rng.state },
    inventory: createInventory(capacityOf(player.initialVehicle, 0, config)),
    gacha: createGachaState(),
    stats: { trips: 0, earnedTotal: 0 },
  }
}

/** 序列化：savedAt 由调用方传入（core 不读时钟，保证可测与可复现） */
export function serializeSave(save: GameSave, savedAt: number): string {
  return JSON.stringify({
    version: SAVE_VERSION,
    savedAt,
    game: {
      player: { ...save.player },
      rng: { ...save.rng },
      // 只写 id + 品相；单价 / 重量 / 占格一律不落盘（读档时从当前 config 取）
      inventory: save.inventory.items.map((picked) => ({ id: picked.item.id, condition: picked.condition })),
      gacha: {
        pityCounters: { ...save.gacha.pityCounters },
        openCount: save.gacha.openCount,
        owned: [...save.gacha.owned],
        shards: save.gacha.shards,
      },
      // 背包容量刻意不写：它是派生值（载具格数 + 扩容格数）
      stats: { ...save.stats },
    },
  })
}

/** 读档后恢复随机序列：接着存档那一刻继续，而不是从种子重来 */
export const restoreRng = (save: GameSave): Rng => createRngFromState(save.rng.state)

/** 存档玩家当前等级（等级不落盘） */
export const saveLevel = (save: GameSave, config: FrozenGameConfig): number =>
  levelFromExp(save.player.exp, config)

/** 存档玩家的背包容量（容量不落盘） */
export const saveCapacity = (save: GameSave, config: FrozenGameConfig): number =>
  capacityOf(save.player.vehicleId, save.player.gridExpansions, config)

/** 时间单位换算（毫秒 → 分钟），与游戏数值无关 */
const MS_PER_MINUTE = 60_000

/**
 * 读档时结算离线体力：离线时长由存档的 savedAt 与当前时间推出来，
 * 上限由 config 的 offlineStaminaCapHours 决定（见 progression.staminaAfterOffline）。
 * 返回新存档与本次恢复量，供界面提示「离线期间恢复了 N 点体力」。
 */
export function applyOfflineStamina(
  save: GameSave,
  savedAt: number,
  now: number,
  config: FrozenGameConfig,
): { save: GameSave; recovered: number } {
  const minutesAway = Math.max(0, (now - savedAt) / MS_PER_MINUTE)
  const stamina = staminaAfterOffline(save.player.stamina, minutesAway, config)
  const recovered = stamina - save.player.stamina

  if (recovered <= 0) return { save, recovered: 0 }
  return { save: { ...save, player: { ...save.player, stamina } }, recovered }
}

// ---------------------------------------------------------------- 反序列化

/**
 * 读档：解析 → 版本迁移 → 结构校验 → 用当前配置重新组装。
 * 无法识别 / 结构错误抛 SaveError；能修的修复后放进 repairs。
 */
export function parseSave(text: string, config: FrozenGameConfig): ParseSaveResult {
  const envelope = parseEnvelope(text)
  let version = envelope.version
  let game: unknown = envelope.game

  if (version > SAVE_VERSION) {
    throw new SaveError(`存档版本 v${version} 比当前客户端（v${SAVE_VERSION}）更新，请升级客户端后再读档`)
  }
  while (version < SAVE_VERSION) {
    const step = MIGRATIONS[version]
    if (step === undefined) {
      throw new SaveError(`缺少 v${version} → v${version + 1} 的存档迁移，无法读取该存档`)
    }
    game = step(game)
    version += 1
  }

  const parsed = saveGameSchema.safeParse(game)
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    throw new SaveError(`存档内容不合法：\n${details.join('\n')}`)
  }

  return rehydrate(parsed.data, config, envelope.savedAt)
}

function parseEnvelope(text: string): { version: number; savedAt: number; game?: unknown } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new SaveError('存档不是合法 JSON（已拒绝加载，避免用坏数据覆盖可用存档）')
  }

  const header = envelopeHeaderSchema.safeParse(raw)
  if (!header.success) {
    throw new SaveError('存档缺少 version / savedAt / game 字段，无法识别格式')
  }
  return header.data
}

function rehydrate(raw: SaveGameWire, config: FrozenGameConfig, savedAt: number): ParseSaveResult {
  const repairs: string[] = []

  // ---- 载具：已不存在就回落初始载具 ----
  let vehicleId = raw.player.vehicleId
  if (!config.vehicles.vehicles.some((vehicle) => vehicle.id === vehicleId)) {
    repairs.push(`载具「${vehicleId}」已不存在，回落为初始载具「${config.global.player.initialVehicle}」`)
    vehicleId = config.global.player.initialVehicle
  }

  // ---- 区域：已不存在或当前等级进不去，就回落默认区域 ----
  const level = levelFromExp(raw.player.exp, config)
  const fallbackZone = defaultZone(config).id
  let zoneId = raw.player.zoneId
  const zone = config.zones.zones.find((candidate) => candidate.id === zoneId)
  if (zone === undefined) {
    repairs.push(`区域「${zoneId}」已不存在，回落为「${fallbackZone}」`)
    zoneId = fallbackZone
  } else if (!isZoneUnlocked(zone, level)) {
    repairs.push(`区域「${zone.name}」需要 Lv${zone.unlockLevel}，当前 Lv${level}，回落为「${fallbackZone}」`)
    zoneId = fallbackZone
  }

  // ---- 体力：配置把上限改小过就夹紧 ----
  const { maxStamina } = config.global.player
  let stamina = raw.player.stamina
  if (stamina > maxStamina) {
    repairs.push(`体力 ${stamina} 超过上限 ${maxStamina}，已夹紧`)
    stamina = maxStamina
  }

  // ---- 背包：容量按当前载具 + 扩容重算；已删除的物品 / 装不下的丢弃 ----
  const gridExpansions = raw.player.gridExpansions
  const capacity = capacityOf(vehicleId, gridExpansions, config)
  const items: PickedItem[] = []
  let usedGrids = 0
  for (const entry of raw.inventory) {
    const item = config.items.items.find((candidate) => candidate.id === entry.id)
    if (item === undefined) {
      repairs.push(`丢弃已不存在的物品「${entry.id}」`)
      continue
    }
    if (usedGrids + item.gridCost > capacity) {
      repairs.push(`背包容量 ${capacity} 格装不下「${item.name}」，已丢弃`)
      continue
    }
    usedGrids += item.gridCost
    items.push({ item, condition: entry.condition })
  }

  // ---- 保底计数：盲盒被删就丢弃对应计数 ----
  const pityCounters: Record<string, number> = {}
  for (const [boxId, count] of Object.entries(raw.gacha.pityCounters)) {
    if (!config.gacha.boxes.some((box) => box.id === boxId)) {
      repairs.push(`丢弃已不存在的盲盒保底计数「${boxId}」`)
      continue
    }
    pityCounters[boxId] = count
  }

  return {
    save: {
      player: {
        money: raw.player.money,
        stamina,
        vehicleId,
        gridExpansions,
        exp: raw.player.exp,
        zoneId,
      },
      rng: { ...raw.rng },
      inventory: { capacity, items },
      gacha: {
        pityCounters,
        openCount: raw.gacha.openCount,
        owned: [...raw.gacha.owned],
        shards: raw.gacha.shards,
      },
      stats: { ...raw.stats },
    },
    savedAt,
    repairs,
  }
}
