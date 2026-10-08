import type { FrozenGameConfig } from '../../config/loader'
import { findZone } from '../../config/schema'
import type { ConditionId, RarityId } from '../../config/schema'
import { analyticsTargetsOf, checkTargets, currentSession, summarize, trackEvent } from '../../core/analytics'
import type { AnalyticsLog, AnalyticsSummary, TargetCheck } from '../../core/analytics'
import { settleBag } from '../../core/economy'
import type { Settlement } from '../../core/economy'
import { remainingGrids, usedGrids } from '../../core/inventory'
import type { PickedItem } from '../../core/pickup'
import {
  canAffordTrip,
  expToNextLevel,
  isZoneUnlocked,
  levelFromExp,
  spendTripStamina,
} from '../../core/progression'
import { restoreRng, saveCapacity } from '../../core/save'
import type { GameSave } from '../../core/save'
import { pickAt, startTrip } from '../../core/trip'
import type { PickOutcome, TripState } from '../../core/trip'
import { writeAnalyticsLog, writeSave } from '../../render/storage'
import type { KeyValueStore } from '../../render/storage'

/**
 * 拾取场景的状态控制器：唯一持有「存档 / 埋点日志 / 当前这一趟」的地方。
 *
 * 它不碰 Pixi、也不碰 DOM —— 渲染（scene.ts）和面板（game-panel.ts）都只读 snapshot()、
 * 只调它的方法。这样玩法状态只有一份，两个视图不会各算各的。
 *
 * 时间一律由调用方传入（now），与 core 保持一致：控制器不读时钟。
 */

export interface ZoneOption {
  readonly id: string
  readonly name: string
  readonly feature: string
  readonly unlockLevel: number
  readonly staminaCost: number
  readonly unlocked: boolean
  readonly affordable: boolean
  readonly current: boolean
}

export interface BagEntry {
  readonly name: string
  readonly rarity: RarityId
  readonly rarityCode: string
  readonly condition: ConditionId
  readonly gridCost: number
}

/** 当前处在哪个界面：街上捡东西 / 垃圾场称重结算 */
export type Phase = 'street' | 'yard'

/** 结算单的一行（展示用；数值全部来自 core 的结算单） */
export interface SettlementLineView {
  readonly name: string
  readonly rarity: RarityId
  readonly rarityCode: string
  readonly condition: ConditionId
  readonly unitPrice: number
  readonly conditionMultiplier: number
  readonly zoneModifier: number
  readonly amount: number
  readonly weightKg: number
}

export interface SettlementView {
  readonly zoneName: string
  readonly lines: readonly SettlementLineView[]
  readonly itemCount: number
  readonly totalGrids: number
  readonly totalWeightKg: number
  readonly gross: number
  readonly expGained: number
  readonly levelBefore: number
  readonly levelAfter: number
  readonly expToNext: number | null
  /** 这次升级新解锁的区域名（没解锁新区域就是空数组） */
  readonly unlockedZones: readonly string[]
}

export interface PickupSnapshot {
  readonly phase: Phase
  readonly settlement: SettlementView | null
  readonly zoneId: string
  readonly zoneName: string
  readonly zoneFeature: string
  readonly zoneStaminaCost: number
  readonly stamina: number
  readonly maxStamina: number
  readonly money: number
  readonly level: number
  readonly exp: number
  readonly bagUsed: number
  readonly bagCapacity: number
  readonly bagRemaining: number
  readonly bag: readonly BagEntry[]
  readonly tripActive: boolean
  readonly taps: number
  readonly emptyTaps: number
  readonly rarityCounts: Readonly<Record<RarityId, number>>
  readonly message: string
  readonly analytics: AnalyticsSummary
  readonly targets: readonly TargetCheck[]
  readonly created: boolean
  readonly savedAt: number | null
  readonly repairs: readonly string[]
}

export interface PickupControllerInit {
  readonly config: FrozenGameConfig
  readonly store: KeyValueStore
  readonly save: GameSave
  readonly log: AnalyticsLog
  readonly created: boolean
  readonly savedAt: number | null
  readonly repairs: readonly string[]
}

export class PickupController {
  private readonly config: FrozenGameConfig
  private readonly store: KeyValueStore
  private readonly listeners = new Set<() => void>()

  private save: GameSave
  private log: AnalyticsLog
  private trip: TripState | null = null
  private zoneId: string
  private message = '点「开始捡拾」出发'
  private phase: Phase = 'street'
  /** 已算出（并入账）的结算单，供垃圾场场景与面板展示 */
  private settlement: Settlement | null = null
  /** 结算前的等级，用来判断这次有没有升级 / 解锁新区域 */
  private levelBefore = 1
  private readonly created: boolean
  private readonly savedAt: number | null
  private readonly repairs: readonly string[]

  constructor(init: PickupControllerInit) {
    this.config = init.config
    this.store = init.store
    this.save = init.save
    this.log = init.log
    this.zoneId = init.save.player.zoneId
    this.created = init.created
    this.savedAt = init.savedAt
    this.repairs = init.repairs
  }

  // ---------------------------------------------------------------- 订阅

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  // ---------------------------------------------------------------- 会话生命周期（main.ts 调用）

  /** 启动：记 app_open 并落盘（崩溃也不丢） */
  beginSession(now: number): void {
    this.log = trackEvent(this.log, {
      name: 'app_open',
      at: now,
      payload: { isNewGame: this.created, savedAt: this.savedAt },
    })
    this.persistLog()
  }

  /** 关页：记 session_end（时长/趟数由 core 按日志算），并落盘存档 */
  endSession(now: number): void {
    const session = currentSession(this.log, now)
    if (session.startedAt !== null) {
      this.log = trackEvent(this.log, {
        name: 'session_end',
        at: now,
        payload: { durationMs: session.durationMs, trips: session.trips, sold: session.sold },
      })
      this.persistLog()
    }
    this.persistSave(now)
  }

  // ---------------------------------------------------------------- 查询

  snapshot(): PickupSnapshot {
    const { config, save } = this
    const zone = findZone(config.zones.zones, this.zoneId)
    const inventory = this.trip?.inventory ?? save.inventory
    const capacity = saveCapacity(save, config)
    const rarityOf = new Map(config.rarity.rarities.map((entry) => [entry.id, entry]))

    const bag: BagEntry[] = inventory.items.map((picked) => ({
      name: picked.item.name,
      rarity: picked.item.rarity,
      rarityCode: rarityOf.get(picked.item.rarity)?.code ?? '?',
      condition: picked.condition,
      gridCost: picked.item.gridCost,
    }))

    const analytics = summarize(this.log)

    return {
      phase: this.phase,
      settlement: this.settlementView(),
      zoneId: zone.id,
      zoneName: zone.name,
      zoneFeature: zone.feature,
      zoneStaminaCost: zone.staminaCost,
      stamina: save.player.stamina,
      maxStamina: config.global.player.maxStamina,
      money: save.player.money,
      level: levelFromExp(save.player.exp, config),
      exp: save.player.exp,
      bagUsed: usedGrids(inventory),
      bagCapacity: capacity,
      bagRemaining: remainingGrids(inventory),
      bag,
      tripActive: this.trip !== null,
      taps: this.trip?.taps ?? 0,
      emptyTaps: this.trip?.emptyTaps ?? 0,
      rarityCounts: this.trip?.rarityCounts ?? { white: 0, green: 0, blue: 0, purple: 0, gold: 0 },
      message: this.message,
      analytics,
      targets: checkTargets(analytics, analyticsTargetsOf(config)),
      created: this.created,
      savedAt: this.savedAt,
      repairs: this.repairs,
    }
  }

  zones(): ZoneOption[] {
    const level = levelFromExp(this.save.player.exp, this.config)
    const stamina = this.save.player.stamina

    return this.config.zones.zones.map((zone) => ({
      id: zone.id,
      name: zone.name,
      feature: zone.feature,
      unlockLevel: zone.unlockLevel,
      staminaCost: zone.staminaCost,
      unlocked: isZoneUnlocked(zone, level),
      affordable: canAffordTrip(zone.id, stamina, this.config),
      current: zone.id === this.zoneId,
    }))
  }

  // ---------------------------------------------------------------- 动作

  /** 切换下一趟要去的区域（只能选已解锁的；体力不够也能选，出发时再拦） */
  selectZone(zoneId: string): void {
    const zone = findZone(this.config.zones.zones, zoneId)
    if (!isZoneUnlocked(zone, levelFromExp(this.save.player.exp, this.config))) {
      this.message = `「${zone.name}」需要 Lv${zone.unlockLevel}，当前 Lv${levelFromExp(this.save.player.exp, this.config)}`
      this.notify()
      return
    }

    this.zoneId = zone.id
    this.save = { ...this.save, player: { ...this.save.player, zoneId: zone.id } }
    this.message = `下一趟：${zone.name}（${zone.staminaCost} 体力）`
    this.notify()
  }

  /** 出发：扣体力 → 开一趟（只在街上可用） */
  startTrip(now: number): void {
    if (this.trip !== null || this.phase !== 'street') return

    const zone = findZone(this.config.zones.zones, this.zoneId)
    if (!canAffordTrip(zone.id, this.save.player.stamina, this.config)) {
      this.message = `体力不够：${zone.name} 一趟要 ${zone.staminaCost}，当前只有 ${Math.floor(this.save.player.stamina)}`
      this.notify()
      return
    }

    const stamina = spendTripStamina(zone.id, this.save.player.stamina, this.config)
    this.save = { ...this.save, player: { ...this.save.player, stamina } }
    this.trip = startTrip(this.config, zone.id, this.save.inventory)
    this.message = `出发去${zone.name}：点垃圾点捡东西（${this.save.inventory.capacity} 格背包）`
    this.persistSave(now)
    this.notify()
  }

  /** 点一次垃圾点；不在趟内返回 null */
  tap(): PickOutcome | null {
    if (this.trip === null) return null
    if (remainingGrids(this.trip.inventory) <= 0) {
      this.message = '背包满了，回程卸货吧'
      this.notify()
      return null
    }

    const rng = restoreRng(this.save)
    const result = pickAt(rng, this.config, this.trip)
    this.trip = result.trip

    // 随机序列必须跟着走：把推进后的状态写回存档，否则读档会重放同一串随机数
    this.save = { ...this.save, rng: { seed: this.save.rng.seed, state: rng.state } }

    switch (result.outcome.kind) {
      case 'empty':
        this.message = '空空如也……这个垃圾点是空的'
        break
      case 'picked':
        this.message = `捡到「${result.outcome.picked.item.name}」`
        break
      case 'full':
        this.message = `装不下：剩 ${remainingGrids(this.trip.inventory)} 格，「${result.outcome.picked.item.name}」要 ${result.outcome.picked.item.gridCost} 格`
        break
    }

    if (remainingGrids(this.trip.inventory) <= 0) this.message += ' —— 背包满了，回程卸货'
    this.notify()
    return result.outcome
  }

  /**
   * 回程 → 垃圾场称重结算（T6）。
   *
   * 结算单由 core/economy.settleBag 出（唯一口径），这里只做三件事：
   *   1. 入账：金币 += 合计金额、经验 += 折算经验
   *   2. 清空背包、切到垃圾场阶段（称重动画只展示已经入账的数字）
   *   3. 记 trip_complete 埋点（T5 时 sold/expGained 还是 0，现在填上真实值）
   * 先入账再动画：这样玩家中途关掉页面也不会「演了一半没拿到钱」。
   */
  returnHome(now: number): void {
    if (this.trip === null) return

    const items: readonly PickedItem[] = this.trip.inventory.items
    const zoneId = this.trip.zoneId
    const settlement = settleBag(items, zoneId, this.config)

    this.levelBefore = levelFromExp(this.save.player.exp, this.config)
    const money = this.save.player.money + settlement.gross
    const exp = this.save.player.exp + settlement.expGained

    this.log = trackEvent(this.log, {
      name: 'trip_complete',
      at: now,
      payload: {
        zoneId,
        itemCount: settlement.itemCount,
        sold: settlement.gross,
        expGained: settlement.expGained,
      },
    })
    this.persistLog()

    this.settlement = settlement
    this.phase = 'yard'
    this.trip = null
    this.save = {
      ...this.save,
      player: { ...this.save.player, money, exp },
      inventory: { capacity: this.save.inventory.capacity, items: [] },
    }
    this.message = settlement.itemCount > 0 ? `垃圾场称重：${settlement.itemCount} 件` : '这趟什么都没捡到'
    this.persistSave(now)
    this.notify()
  }

  /** 结算完回街上（可以再跑一趟） */
  backToStreet(now: number): void {
    if (this.phase !== 'yard') return

    this.phase = 'street'
    this.settlement = null
    this.message = '回到街上：点「开始捡拾」再跑一趟'
    this.persistSave(now)
    this.notify()
  }

  // ---------------------------------------------------------------- 内部

  /** 结算单 → 展示用视图（每个数字都取自 core 的结算单，这里不做任何运算） */
  private settlementView(): SettlementView | null {
    const settlement = this.settlement
    if (settlement === null) return null

    const rarityOf = new Map(this.config.rarity.rarities.map((entry) => [entry.id, entry]))
    const levelAfter = levelFromExp(this.save.player.exp, this.config)

    return {
      zoneName: findZone(this.config.zones.zones, settlement.zoneId).name,
      lines: settlement.lines.map((line) => ({
        name: line.picked.item.name,
        rarity: line.picked.item.rarity,
        rarityCode: rarityOf.get(line.picked.item.rarity)?.code ?? '?',
        condition: line.picked.condition,
        unitPrice: line.unitPrice,
        conditionMultiplier: line.conditionMultiplier,
        zoneModifier: line.zoneModifier,
        amount: line.amount,
        weightKg: line.weightKg,
      })),
      itemCount: settlement.itemCount,
      totalGrids: settlement.totalGrids,
      totalWeightKg: settlement.totalWeightKg,
      gross: settlement.gross,
      expGained: settlement.expGained,
      levelBefore: this.levelBefore,
      levelAfter,
      expToNext: expToNextLevel(this.save.player.exp, this.config),
      unlockedZones: this.config.zones.zones
        .filter((zone) => isZoneUnlocked(zone, levelAfter) && !isZoneUnlocked(zone, this.levelBefore))
        .map((zone) => zone.name),
    }
  }

  private persistSave(now: number): void {
    writeSave(this.store, this.save, now)
  }

  private persistLog(): void {
    writeAnalyticsLog(this.store, this.log)
  }
}
