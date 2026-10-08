import { Container, Graphics, Text } from 'pixi.js'
import type { Application, Ticker } from 'pixi.js'

import type { FrozenGameConfig } from '../../config/loader'
import { formatExp, formatKg, formatMoney } from '../../ui/format'
import type { PickupController, SettlementLineView } from '../pickup/controller'

/**
 * 垃圾场称重结算场景（T6）。
 *
 * 这里**不做任何金额计算**：逐件落秤时滚动的前缀累加只是动画效果，
 * 最终总额 / 总重 / 经验一律直接展示 core 结算单的字段
 * —— T6 验收「界面显示金额与 core 出数完全一致」。
 *
 * 美术仍是占位（纯色块 + 文字）。
 */

/** 渲染参数：与游戏数值无关 */
const PER_ITEM_MS = 340
const AFTER_LAST_MS = 420
const CHIP_WIDTH = 40
const CHIP_HEIGHT = 26
const CHIP_GAP = 8
const FONT = 'system-ui, "Microsoft YaHei", "PingFang SC", sans-serif'
const COLOR_YARD = 0xf0eee6
const COLOR_FRAME = 0xe0dcd0
const COLOR_SCALE = 0xd7d2c5
const COLOR_PAN = 0xc6bfae
const COLOR_INK = 0x1f2328
const COLOR_MUTED = 0x5a6169
const COLOR_MONEY = 0xb8860b
const COLOR_LEVELUP = 0x2f7d6e

export class YardScene {
  private readonly app: Application
  private readonly controller: PickupController
  private readonly config: FrozenGameConfig

  private readonly world = new Container()
  private readonly frame = new Graphics()
  private readonly scale = new Graphics()
  private readonly title = new Text({
    text: '垃圾场 · 称重结算',
    style: { fontFamily: FONT, fontSize: 17, fill: COLOR_INK, fontWeight: '600' },
  })
  private readonly subtitle = new Text({
    text: '',
    style: { fontFamily: FONT, fontSize: 13, fill: COLOR_MUTED },
  })
  private readonly counterText = new Text({
    text: '',
    style: { fontFamily: FONT, fontSize: 15, fill: COLOR_INK, fontWeight: '600' },
  })
  private readonly weightText = new Text({ text: '', style: { fontFamily: FONT, fontSize: 15, fill: COLOR_INK } })
  private readonly moneyText = new Text({
    text: '',
    style: { fontFamily: FONT, fontSize: 26, fill: COLOR_MONEY, fontWeight: '700' },
  })
  private readonly totalText = new Text({ text: '', style: { fontFamily: FONT, fontSize: 15, fill: COLOR_INK } })
  private readonly levelText = new Text({
    text: '',
    style: { fontFamily: FONT, fontSize: 15, fill: COLOR_LEVELUP, fontWeight: '700', align: 'center' },
  })

  private readonly chips: Container[] = []
  private readonly chipBodies: Graphics[] = []

  private landed = 0
  private elapsedMs = 0
  private done = false
  private running = false
  private paintedLanded = -1
  private paintedDone = false

  constructor(app: Application, controller: PickupController, config: FrozenGameConfig) {
    this.app = app
    this.controller = controller
    this.config = config
  }

  mount(): void {
    this.app.stage.addChild(this.world)
    this.world.addChild(this.frame, this.scale)

    this.title.position.set(18, 16)
    this.subtitle.position.set(18, 40)
    this.counterText.anchor.set(0.5)
    this.weightText.anchor.set(0.5)
    this.moneyText.anchor.set(0.5)
    this.totalText.anchor.set(0.5)
    this.levelText.anchor.set(0.5)
    this.world.addChild(
      this.title,
      this.subtitle,
      this.counterText,
      this.weightText,
      this.moneyText,
      this.totalText,
      this.levelText,
    )

    this.app.ticker.add(this.onTick)
    this.layout()
    this.paint()
  }

  /** 每次进垃圾场重播一次称重动画 */
  start(): void {
    const settlement = this.controller.snapshot().settlement
    this.syncChips(settlement?.lines.length ?? 0)
    this.landed = 0
    this.elapsedMs = 0
    this.done = false
    this.running = true
    this.paintedLanded = -1
    this.paintedDone = false
    this.paint()
  }

  setVisible(visible: boolean): void {
    this.world.visible = visible
    this.running = visible
  }

  layout(): void {
    const width = this.app.screen.width
    const height = this.app.screen.height

    this.frame
      .clear()
      .roundRect(0, 0, width, height, 20)
      .fill(COLOR_YARD)
      .stroke({ width: 1, color: COLOR_FRAME })

    const scaleWidth = Math.min(420, width * 0.62)
    const scaleX = width / 2 - scaleWidth / 2
    const scaleY = height * 0.62

    this.scale
      .clear()
      .roundRect(scaleX, scaleY, scaleWidth, 18, 9)
      .fill(COLOR_SCALE)
      .roundRect(scaleX + 14, scaleY - 12, scaleWidth - 28, 14, 7)
      .fill(COLOR_PAN)

    this.title.position.set(18, 16)
    this.subtitle.position.set(18, 40)

    const centerX = width / 2
    this.counterText.position.set(centerX, height * 0.22)
    this.weightText.position.set(centerX, height * 0.22 + 26)
    this.moneyText.position.set(centerX, height * 0.38)
    this.totalText.position.set(centerX, scaleY + 54)
    this.levelText.position.set(centerX, scaleY + 84)

    this.layoutChips(centerX, scaleY - 26)
  }

  destroy(): void {
    this.app.ticker.remove(this.onTick)
    this.world.destroy({ children: true })
  }

  // ---------------------------------------------------------------- 绘制

  private syncChips(count: number): void {
    while (this.chips.length < count) {
      const node = new Container()
      const body = new Graphics()
      node.addChild(body)
      this.world.addChild(node)
      this.chips.push(node)
      this.chipBodies.push(body)
    }
    for (const [index, node] of this.chips.entries()) node.visible = index < count
  }

  private layoutChips(centerX: number, panY: number): void {
    const perRow = Math.max(1, Math.floor((this.app.screen.width * 0.8) / (CHIP_WIDTH + CHIP_GAP)))

    this.chips.forEach((node, index) => {
      const row = Math.floor(index / perRow)
      const column = index % perRow
      const rowCount = Math.min(perRow, this.chips.length - row * perRow)
      const rowWidth = rowCount * CHIP_WIDTH + (rowCount - 1) * CHIP_GAP
      node.position.set(centerX - rowWidth / 2 + column * (CHIP_WIDTH + CHIP_GAP), panY - row * (CHIP_HEIGHT + 6))
      node.x += CHIP_WIDTH / 2
    })
  }

  private colorOf(rarityCode: string): number {
    const rarity = this.config.rarity.rarities.find((entry) => entry.code === rarityCode)
    return rarity === undefined ? COLOR_PAN : Number.parseInt(rarity.color.slice(1), 16)
  }

  private paint(): void {
    const settlement = this.controller.snapshot().settlement
    if (settlement === null) return

    this.subtitle.text = `来自「${settlement.zoneName}」· 逐件过秤`
    this.counterText.text = `已过秤 ${this.landed} / ${settlement.lines.length} 件`
    this.weightText.text = `秤上 ${formatKg(this.prefixWeight(settlement.lines, this.landed))}`
    this.moneyText.text = `${formatMoney(this.grossAt(settlement.lines, this.landed))} 元`

    this.syncChips(settlement.lines.length)
    this.layoutChips(this.app.screen.width / 2, this.app.screen.height * 0.62 - 26)

    this.chips.forEach((node, index) => {
      const line = settlement.lines[index]
      const body = this.chipBodies[index]
      if (line === undefined || body === undefined) return

      const landed = index < this.landed
      node.alpha = landed ? 1 : 0.18
      body
        .clear()
        .roundRect(-CHIP_WIDTH / 2, -CHIP_HEIGHT / 2, CHIP_WIDTH, CHIP_HEIGHT, 6)
        .fill(this.colorOf(line.rarityCode))
        .stroke({ width: 2, color: landed ? COLOR_INK : COLOR_PAN })
    })

    if (this.done) {
      // 最终数字一律取 core 结算单的字段，不做任何再计算
      this.totalText.text = `合计 ${formatMoney(settlement.gross)} 元 · 经验 +${formatExp(settlement.expGained)}`
      this.levelText.text = settlement.unlockedZones.length > 0
        ? `升级！Lv${settlement.levelBefore} → Lv${settlement.levelAfter}，解锁「${settlement.unlockedZones.join('、')}」`
        : settlement.levelAfter > settlement.levelBefore
          ? `升级！Lv${settlement.levelBefore} → Lv${settlement.levelAfter}`
          : ''
      this.moneyText.style.fill = COLOR_MONEY
    } else {
      this.totalText.text = '过秤中……'
      this.levelText.text = ''
    }
  }

  /** 逐件落秤时的前缀累加（纯动画效果；最终值一律取 core 字段） */
  private prefixWeight(lines: readonly SettlementLineView[], count: number): number {
    let total = 0
    for (let index = 0; index < count; index += 1) total += lines[index]?.weightKg ?? 0
    return total
  }

  private grossAt(lines: readonly SettlementLineView[], count: number): number {
    let total = 0
    for (let index = 0; index < count; index += 1) total += lines[index]?.amount ?? 0
    return total
  }

  // ---------------------------------------------------------------- 每帧

  private readonly onTick = (ticker: Ticker): void => {
    if (!this.running) return

    const settlement = this.controller.snapshot().settlement
    if (settlement === null) return

    const total = settlement.lines.length
    this.elapsedMs += ticker.deltaMS

    const landed = Math.min(total, Math.floor(this.elapsedMs / PER_ITEM_MS))
    const done = this.elapsedMs >= total * PER_ITEM_MS + AFTER_LAST_MS

    if (landed !== this.paintedLanded || done !== this.paintedDone) {
      this.landed = landed
      this.done = done
      this.paintedLanded = landed
      this.paintedDone = done
      this.paint()
    }
  }
}
