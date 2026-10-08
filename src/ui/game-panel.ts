import type { FrozenGameConfig } from '../config/loader'
import { RARITY_IDS } from '../config/schema'
import type { ConditionId, RarityId } from '../config/schema'
import type { PickupController, PickupSnapshot } from '../scenes/pickup/controller'

/**
 * 侧栏面板（DOM）：状态、操作按钮、区域切换、本趟产出统计、存档与埋点摘要。
 *
 * 它只读 controller.snapshot()、只调 controller 的方法 —— 自己不算任何玩法数值。
 * 画布负责「游戏世界」，面板负责「系统界面」，两边靠一个控制器同步。
 */

const CONDITION_LABEL: Record<ConditionId, string> = { pristine: '完好', worn: '磨损', broken: '破损' }

export interface GamePanelOptions {
  readonly host: HTMLElement
  readonly controller: PickupController
  readonly config: FrozenGameConfig
}

const esc = (value: string): string =>
  value.replace(/[&<>"]/g, (char) =>
    char === '&' ? '&amp;' : char === '<' ? '&lt;' : char === '>' ? '&gt;' : '&quot;',
  )

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`

function statsHtml(snapshot: PickupSnapshot, config: FrozenGameConfig): string {
  return `
    <dl class="meta">
      <dt>区域</dt><dd>${esc(snapshot.zoneName)}（一趟 ${snapshot.zoneStaminaCost} 体力）</dd>
      <dt>体力</dt><dd>${Math.floor(snapshot.stamina)} / ${snapshot.maxStamina}</dd>
      <dt>背包</dt><dd>${snapshot.bagUsed} / ${snapshot.bagCapacity} 格（剩 ${snapshot.bagRemaining}）</dd>
      <dt>金币</dt><dd>${Math.floor(snapshot.money)}（T6 才结算）</dd>
      <dt>等级</dt><dd>Lv${snapshot.level} · 经验 ${Math.floor(snapshot.exp)}</dd>
      <dt>满仓时长</dt><dd>${config.global.player.maxStamina / config.global.player.staminaRecoverPerMinute} 分钟</dd>
    </dl>`
}

function actionsHtml(snapshot: PickupSnapshot): string {
  const canStart = !snapshot.tripActive
  return `
    <div class="panel-actions">
      <button type="button" data-action="start" ${canStart ? '' : 'disabled'}>开始捡拾</button>
      <button type="button" data-action="home" ${snapshot.tripActive ? '' : 'disabled'}>回程卸货</button>
    </div>`
}

function zonesHtml(controller: PickupController): string {
  const buttons = controller
    .zones()
    .map((zone) => {
      const cls = ['zone-btn', zone.current ? 'is-current' : '', zone.unlocked ? '' : 'is-locked']
        .filter(Boolean)
        .join(' ')
      const title = zone.unlocked ? `一趟 ${zone.staminaCost} 体力` : `需要 Lv${zone.unlockLevel}`
      return `<button type="button" class="${cls}" data-action="zone" data-zone="${esc(zone.id)}" ${
        zone.current ? 'disabled' : ''
      } title="${esc(title)}">${esc(zone.name)}<span>${zone.staminaCost}</span></button>`
    })
    .join('')

  return `<div class="panel-zones">${buttons}</div>`
}

function tripHtml(snapshot: PickupSnapshot, config: FrozenGameConfig): string {
  const zone = config.zones.zones.find((candidate) => candidate.id === snapshot.zoneId)
  const picked = RARITY_IDS.reduce((total, rarity) => total + (snapshot.rarityCounts[rarity] ?? 0), 0)

  const rows = RARITY_IDS.map((rarity) => {
    const entry = config.rarity.rarities.find((candidate) => candidate.id === rarity)
    const observed = picked > 0 ? (snapshot.rarityCounts[rarity] ?? 0) / picked : null
    const expected = zone?.dropRates[rarity] ?? 0
    return `<dt>${esc(entry?.code ?? '?')} ${esc(entry?.name ?? rarity)}</dt><dd>${
      observed === null ? '—' : pct(observed)
    } <span class="muted">/ 期望 ${pct(expected)}</span></dd>`
  }).join('')

  const ghost = snapshot.taps > 0 ? snapshot.emptyTaps / snapshot.taps : null
  const ghostExpected = zone?.emptyPointRate ?? 0

  return `
    <dl class="meta">
      <dt>点击次数</dt><dd>${snapshot.taps}（假点 ${snapshot.emptyTaps}）</dd>
      <dt>已入包</dt><dd>${picked} 件</dd>
      ${rows}
      <dt>假点率</dt><dd>${ghost === null ? '—' : pct(ghost)} <span class="muted">/ 期望 ${pct(ghostExpected)}</span></dd>
    </dl>
    <p class="hint">这一栏就是 T5 的验收口径：实测产出与区域 dropRates 逐档对比，点得越多越接近。</p>`
}

function bagHtml(snapshot: PickupSnapshot, config: FrozenGameConfig): string {
  if (snapshot.bag.length === 0) return '<p class="hint">背包是空的。</p>'
  const items = snapshot.bag
    .map(
      (entry) =>
        `<li><span class="rarity-dot" style="background:${rarityColorOf(config, entry.rarity)}"></span>${esc(entry.name)}` +
        `<span class="muted">${esc(entry.rarityCode)}·${CONDITION_LABEL[entry.condition]} · ${entry.gridCost} 格</span></li>`,
    )
    .join('')
  return `<ul class="bag-list">${items}</ul>`
}

function saveHtml(snapshot: PickupSnapshot): string {
  const savedAt = snapshot.savedAt === null ? '—' : new Date(snapshot.savedAt).toLocaleString()
  const repairs = snapshot.repairs.length === 0 ? '无' : snapshot.repairs.join('；')
  return `
    <dl class="meta">
      <dt>存档</dt><dd>${snapshot.created ? '本次新建' : '已读取'} · 落盘 ${esc(savedAt)}</dd>
      <dt>读档修复</dt><dd>${esc(repairs)}</dd>
    </dl>`
}

function targetsHtml(snapshot: PickupSnapshot): string {
  const rows = snapshot.targets
    .map((check) => `<dt>${check.ok ? '✓' : '✗'} ${esc(check.label)}</dt><dd>${esc(check.actualText)} <span class="muted">/ 目标 ${esc(check.targetText)}</span></dd>`)
    .join('')
  const summary = snapshot.analytics
  return `
    <dl class="meta">
      <dt>事件数</dt><dd>${summary.eventCount} 条（启动 ${summary.appOpens} 次 · 活跃 ${summary.activeDays} 天 · 完整会话 ${summary.sessions} 次）</dd>
      <dt>货架→购买</dt><dd>${summary.buyConversion === null ? '—' : pct(summary.buyConversion)}</dd>
      ${rows}
    </dl>`
}

function panelHtml(controller: PickupController, config: FrozenGameConfig): string {
  const snapshot = controller.snapshot()
  return `
    <section class="panel-block">
      <h2>拾取</h2>
      ${statsHtml(snapshot, config)}
      ${actionsHtml(snapshot)}
      ${zonesHtml(controller)}
      <p class="hint">左侧地图可拖拽平移；点圆形垃圾点捡东西（有假点）。</p>
    </section>
    <section class="panel-block">
      <h2>本趟产出</h2>
      ${tripHtml(snapshot, config)}
    </section>
    <section class="panel-block">
      <h2>背包</h2>
      ${bagHtml(snapshot, config)}
    </section>
    <section class="panel-block">
      <h2>存档</h2>
      ${saveHtml(snapshot)}
    </section>
    <section class="panel-block">
      <h2>埋点与验收指标</h2>
      ${targetsHtml(snapshot)}
    </section>`
}

/** 档位颜色：与画布飘字同一来源（config/rarity.json 的 color），不另建色表 */
export function rarityColorOf(config: FrozenGameConfig, rarity: RarityId): string {
  return config.rarity.rarities.find((entry) => entry.id === rarity)?.color ?? '#cccccc'
}

/** 挂载面板；返回卸载函数 */
export function mountGamePanel(options: GamePanelOptions): () => void {
  const { host, controller, config } = options
  host.classList.add('panel')

  const onClick = (event: MouseEvent): void => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const button = target.closest<HTMLButtonElement>('button[data-action]')
    if (button === null) return

    const now = Date.now()
    switch (button.dataset.action) {
      case 'start':
        controller.startTrip(now)
        break
      case 'home':
        controller.returnHome(now)
        break
      case 'zone': {
        const zoneId = button.dataset.zone
        if (zoneId !== undefined) controller.selectZone(zoneId)
        break
      }
      default:
        break
    }
  }

  host.addEventListener('click', onClick)
  const unsubscribe = controller.subscribe(() => {
    host.innerHTML = panelHtml(controller, config)
  })
  host.innerHTML = panelHtml(controller, config)

  return () => {
    host.removeEventListener('click', onClick)
    unsubscribe()
  }
}
