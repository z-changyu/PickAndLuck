/**
 * 配置校验 CLI：`npm run check-config`
 *
 * CI / 提交前跑一遍，保证 config/ 下的 6 份 JSON 结构合法、派生值自洽、关键不变量成立。
 * 退出码：0 = 通过，1 = 失败（便于接入 CI）。
 */
import { CONFIG_FILE_NAMES, ConfigValidationError, loadConfig } from '../src/config/loader'
import { expectedReturnRateWithPity, staminaRefillMinutes } from '../src/config/schema'
import type { RarityId } from '../src/config/schema'

try {
  const config = loadConfig()
  console.info(`✓ config/ 校验通过（${CONFIG_FILE_NAMES.join(' / ')}）`)
  console.info(
    `  · 稀有度 ${config.rarity.rarities.length} 档 · 街头物品 ${config.items.items.length} 件 · ` +
      `区域 ${config.zones.zones.length} 个 · 盲盒 ${config.gacha.boxes.length} 款 · 载具 ${config.vehicles.vehicles.length} 级`,
  )
  console.info(
    '  · 已校验：概率合计 = 1、派生值自洽、材料返还率 0.55–0.65、区域每体力收益增幅 ≤ 10%、载具攒钱趟数 8–18、跨文件引用完整',
  )
  console.info('  · 已校验：每个区域 × 每档位都有可拾取物品、品相权重合计 = 1、假点率 < 1、等级曲线递增且覆盖所有 unlockLevel')
  const { maxStamina, staminaRecoverPerMinute, offlineStaminaCapHours, adStaminaRefillAmount } = config.global.player
  console.info(
    `  · 体力：上限 ${maxStamina} · 恢复 ${staminaRecoverPerMinute} 点/分钟（满仓 ${staminaRefillMinutes(config.global.player)} 分钟）` +
      ` · 离线封顶 ${offlineStaminaCapHours} 小时 · 广告恢复 ${adStaminaRefillAmount} 点/次`,
  )
  console.info('  · 盲盒返还率（声明 → 含保底，两列都必须落在 55%–65%）：')
  const materialValue = new Map<RarityId, number>(
    config.rarity.rarities.map((rarity) => [rarity.id, rarity.materialValue]),
  )
  for (const box of config.gacha.boxes) {
    const withPity = expectedReturnRateWithPity(box, materialValue, config.gacha.pity.targetRarity)
    console.info(
      `      ${box.name.padEnd(6)} 售价 ${String(box.price).padStart(3)} 元 · 保底 ${String(box.pityCounter ?? '不设').padStart(3)} 抽 · ` +
        `${((box.materialReturnRate ?? 0) * 100).toFixed(2)}% → ${(withPity * 100).toFixed(2)}%`,
    )
  }
} catch (error) {
  if (error instanceof ConfigValidationError) {
    console.error(`✗ 配置校验失败，共 ${error.issues.length} 处问题：`)
    error.issues.forEach((issue, index) => {
      console.error(`  ${index + 1}) ${issue}`)
    })
  } else {
    console.error('✗ 配置加载异常：', error)
  }
  process.exitCode = 1
}
