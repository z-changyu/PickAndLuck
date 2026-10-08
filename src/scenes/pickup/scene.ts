import { Container, Graphics, Text } from 'pixi.js'
import type { Application, FederatedPointerEvent, Ticker } from 'pixi.js'

import type { FrozenGameConfig } from '../../config/loader'
import type { ConditionId } from '../../config/schema'
import type { PickOutcome } from '../../core/trip'
import type { PickupController, PickupSnapshot } from './controller'

/**
 * 拾取场景的「画面部分」：地图、垃圾点、飘字、提示条。
 *
 * 这里只做两件事：把 snapshot 画出来、把点击转成 controller.tap()。
 * 玩法状态一律在 controller / core 里 —— 渲染层不知道自己捡到了什么，
 * 它只是拿到 outcome 然后画。
 *
 * 美术一律先用占位（纯色块 + 文字），参见 README「资产与合规」。
 */

/** 渲染参数：与游戏数值无关，只影响观感（放在渲染层本地常量里） */
const SITE_POOL = 9
const SITE_RADIUS = 26
const SITE_CONSUMED_MS = 380
const SITE_SHAKE_MS = 220
const TOAST_LIFE_MS = 1300
const TOAST_RISE = 52
const PAN_MARGIN = 170
const DRAG_THRESHOLD = 6
const COLOR_MAP = 0xfbfaf7
const COLOR_SITE = 0xe7e3da
const COLOR_SITE_LINE = 0x8b939c
const COLOR_EMPTY = 0xd9d6cf
const COLOR_DANGER = 0xc2410c
const COLOR_INK = 0x1f2328
const COLOR_MUTED = 0x5a6169
const FONT = 'system-ui, "Microsoft YaHei", "PingFang SC", sans-serif'
const CONDITION_LABEL: Record<ConditionId, string> = { pristine: '完好', worn: '磨损', broken: '破损' }

interface Site {
  readonly node: Container
  readonly body: Graphics
  readonly hint: Text
  slotX: number
  slotY: number
  consumedMs: number
  shakeMs: number
}

interface Toast {
  readonly node: Text
  life: number
}

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max)

export class PickupScene {
  private readonly app: Application
  private readonly controller: PickupController
  private readonly config: FrozenGameConfig

  private readonly world = new Container()
  private readonly hud = new Container()
  private readonly frame = new Graphics()
  private readonly title = new Text({ text: '', style: { fontFamily: FONT, fontSize: 16, fill: COLOR_INK, fontWeight: '600' } })
  private readonly message = new Text({
    text: '',
    style: { fontFamily: FONT, fontSize: 14, fill: COLOR_MUTED, align: 'center' },
  })

  private readonly sites: Site[] = []
  private readonly toasts: Toast[] = []

  private dragging = false
  private dragDistance = 0
  private lastPointer = { x: 0, y: 0 }
  private unsubscribe: (() => void) | null = null

  constructor(app: Application, controller: PickupController, config: FrozenGameConfig) {
    this.app = app
    this.controller = controller
    this.config = config
  }

  mount(): void {
    this.app.stage.addChild(this.world, this.hud)
    this.world.addChild(this.frame)
    for (let index = 0; index < SITE_POOL; index += 1) this.world.addChild(this.createSite(index).node)

    this.title.anchor.set(0, 0)
    this.title.position.set(18, 16)
    this.message.anchor.set(0.5, 1)
    this.hud.addChild(this.title, this.message)

    this.world.x = -PAN_MARGIN
    this.world.y = -PAN_MARGIN

    this.bindPointer()
    this.app.ticker.add(this.onTick)
    this.unsubscribe = this.controller.subscribe(() => this.render())
    this.layout()
    this.render()
  }

  /** 尺寸变化时重排（main.ts 在 resize 时调用） */
  layout(): void {
    const viewWidth = this.app.screen.width
    const viewHeight = this.app.screen.height
    const worldWidth = viewWidth + PAN_MARGIN * 2
    const worldHeight = viewHeight + PAN_MARGIN * 2

    this.frame.clear()
    this.frame
      .roundRect(0, 0, worldWidth, worldHeight, 22)
      .fill(COLOR_MAP)
      .stroke({ width: 1, color: 0xe6e3dd })

    const cols = 3
    const rows = Math.ceil(SITE_POOL / cols)
    this.sites.forEach((site, index) => {
      // 确定性抖动：渲染层不许用 Math.random（否则画面会破坏随机序列可复现性）
      const jitterX = ((index * 37) % 41) - 20
      const jitterY = ((index * 53) % 37) - 18
      site.slotX = ((index % cols) + 0.5) * (worldWidth / cols) + jitterX
      site.slotY = worldHeight * 0.12 + (Math.floor(index / cols) + 0.5) * (worldHeight * 0.76 / rows) + jitterY
      site.node.position.set(site.slotX, site.slotY)
    })

    this.world.x = clamp(this.world.x, -PAN_MARGIN, 0)
    this.world.y = clamp(this.world.y, -PAN_MARGIN, 0)

    this.title.position.set(18, 16)
    this.message.position.set(viewWidth / 2, viewHeight - 22)

    this.app.stage.hitArea = this.app.screen
  }

  destroy(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.app.ticker.remove(this.onTick)
    this.world.destroy({ children: true })
    this.hud.destroy({ children: true })
  }

  // ---------------------------------------------------------------- 绘制

  private readonly render = (): void => {
    const snapshot = this.controller.snapshot()

    this.title.text = `${snapshot.zoneName} · ${snapshot.zoneFeature}`
    this.message.text = snapshot.message
    this.paintSites(snapshot)
  }

  private paintSites(snapshot: PickupSnapshot): void {
    const canTap = snapshot.tripActive && snapshot.bagRemaining > 0
    for (const site of this.sites) {
      site.node.alpha = canTap ? 1 : 0.42
      this.paintSite(site)
    }
    this.message.style.fill = canTap ? COLOR_MUTED : COLOR_DANGER
  }

  private paintSite(site: Site): void {
    const consumed = site.consumedMs > 0
    site.body
      .clear()
      .circle(0, 0, SITE_RADIUS)
      .fill(consumed ? COLOR_EMPTY : COLOR_SITE)
      .stroke({ width: 2, color: COLOR_SITE_LINE })
    site.hint.text = consumed ? '空' : '?'
    site.hint.style.fill = consumed ? COLOR_MUTED : COLOR_INK
  }

  private createSite(index: number): Site {
    const node = new Container()
    const body = new Graphics()
    const hint = new Text({ text: '?', style: { fontFamily: FONT, fontSize: 16, fill: COLOR_INK, fontWeight: '700' } })
    hint.anchor.set(0.5)

    node.addChild(body, hint)
    node.eventMode = 'static'
    node.cursor = 'pointer'

    const site: Site = { node, body, hint, slotX: 0, slotY: 0, consumedMs: 0, shakeMs: 0 }
    this.paintSite(site)
    node.on('pointertap', () => this.handleTap(site))
    void index
    this.sites.push(site)
    return site
  }

  // ---------------------------------------------------------------- 交互

  private bindPointer(): void {
    const stage = this.app.stage
    stage.eventMode = 'static'

    stage.on('pointerdown', (event: FederatedPointerEvent) => {
      this.dragging = true
      this.dragDistance = 0
      this.lastPointer = { x: event.global.x, y: event.global.y }
    })

    stage.on('globalpointermove', (event: FederatedPointerEvent) => {
      if (!this.dragging) return
      const dx = event.global.x - this.lastPointer.x
      const dy = event.global.y - this.lastPointer.y
      this.lastPointer = { x: event.global.x, y: event.global.y }
      this.dragDistance += Math.abs(dx) + Math.abs(dy)

      // 拖拽平移地图（阶段一的「地图移动」占位；T5 之后再做角色行走）
      this.world.x = clamp(this.world.x + dx, -PAN_MARGIN, 0)
      this.world.y = clamp(this.world.y + dy, -PAN_MARGIN, 0)
    })

    const stopDrag = (): void => {
      this.dragging = false
    }
    stage.on('pointerup', stopDrag)
    stage.on('pointerupoutside', stopDrag)
  }

  private handleTap(site: Site): void {
    if (this.dragDistance > DRAG_THRESHOLD) return // 这一下是在拖地图，不是在点垃圾点

    const outcome = this.controller.tap()
    if (outcome === null) {
      site.shakeMs = SITE_SHAKE_MS
      return
    }
    this.showOutcome(site, outcome)
  }

  private showOutcome(site: Site, outcome: PickOutcome): void {
    switch (outcome.kind) {
      case 'empty':
        site.consumedMs = SITE_CONSUMED_MS
        this.spawnToast(site, '空空如也', COLOR_MUTED)
        break
      case 'picked': {
        const entry = this.config.rarity.rarities.find((rarity) => rarity.id === outcome.picked.item.rarity)
        const color = entry === undefined ? COLOR_INK : Number.parseInt(entry.color.slice(1), 16)
        site.consumedMs = SITE_CONSUMED_MS
        this.spawnToast(
          site,
          `+${outcome.picked.item.name}（${entry?.code ?? '?'}·${CONDITION_LABEL[outcome.picked.condition]}）`,
          color,
        )
        break
      }
      case 'full':
        site.shakeMs = SITE_SHAKE_MS
        this.spawnToast(site, '装不下，先回程卸货', COLOR_DANGER)
        break
    }
    this.paintSite(site)
  }

  private spawnToast(site: Site, text: string, color: number): void {
    const node = new Text({ text, style: { fontFamily: FONT, fontSize: 14, fill: color, fontWeight: '700' } })
    node.anchor.set(0.5, 1)
    node.position.set(site.slotX, site.slotY - SITE_RADIUS - 6)
    this.world.addChild(node)
    this.toasts.push({ node, life: TOAST_LIFE_MS })
  }

  // ---------------------------------------------------------------- 每帧

  private readonly onTick = (ticker: Ticker): void => {
    const deltaMs = ticker.deltaMS

    for (const site of this.sites) {
      if (site.consumedMs > 0) {
        site.consumedMs -= deltaMs
        if (site.consumedMs <= 0) {
          site.consumedMs = 0
          this.paintSite(site)
        }
      }
      if (site.shakeMs > 0) {
        site.shakeMs -= deltaMs
        site.node.x = site.slotX + Math.sin(site.shakeMs / 14) * 5
        if (site.shakeMs <= 0) site.node.x = site.slotX
      }
    }

    for (let index = this.toasts.length - 1; index >= 0; index -= 1) {
      const toast = this.toasts[index]
      if (toast === undefined) continue
      toast.life -= deltaMs
      const progress = 1 - toast.life / TOAST_LIFE_MS
      toast.node.y -= (TOAST_RISE / TOAST_LIFE_MS) * deltaMs
      toast.node.alpha = progress < 0.7 ? 1 : Math.max(0, 1 - (progress - 0.7) / 0.3)

      if (toast.life <= 0) {
        toast.node.destroy()
        this.toasts.splice(index, 1)
      }
    }
  }
}
