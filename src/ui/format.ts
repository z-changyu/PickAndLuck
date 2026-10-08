import type { ConditionId } from '../config/schema'

/**
 * 显示层格式化：全工程只有这一处把 core 的数字变成字符串。
 *
 * T6 的验收是「界面显示金额与 core 出数完全一致」——保证这件事的办法不是小心谨慎，
 * 而是只留一个出口：界面拿到的永远是 core 字段，再交给这里的函数格式化，绝不自己算。
 */

/** 金额：core 内部不取整，显示统一保留两位小数 */
export const formatMoney = (value: number): string => value.toFixed(2)

/** 重量（kg） */
export const formatKg = (value: number): string => `${value.toFixed(2)} kg`

/** 经验：经验 = 出售额 × expPerCurrency，天然带小数，与金额同为两位 */
export const formatExp = (value: number): string => value.toFixed(2)

/** 比例 → 百分比文本 */
export const formatPercent = (ratio: number): string => `${(ratio * 100).toFixed(1)}%`

/** 品相中文名（三处界面共用一份，避免各写一份漂移） */
export const CONDITION_LABEL: Record<ConditionId, string> = {
  pristine: '完好',
  worn: '磨损',
  broken: '破损',
}

export const conditionLabel = (condition: ConditionId): string => CONDITION_LABEL[condition]
