---
description: 改数值时必须同步 design/ 与 config/，并跑配置校验
alwaysApply: false
---

# 数值变更同步流程（design/ ↔ config/）

## 唯一数据源

```
design/捡漏_数值框架.xlsx   ← 策划改数值的唯一入口（人看、人改）
        │  导出
        ▼
config/*.json               ← 运行时唯一来源（代码只读这里）
```

**代码永远不读 `design/`，永远不写死数值。**

## 改数值的固定动作

1. 在 `design/捡漏_数值框架.xlsx` 里改，先确认该表的「概率合计」「概率合计(校验)」两列仍为 100%
2. 把改动同步到对应的 `config/*.json`（**包括派生值列**，如 `dropRatesSum`、`avgUnitValue`、`expectedMaterialValue`、`materialReturnRate`）
3. 跑校验三连：

```bash
npm run check-config   # 结构 + 跨文件引用 + 不变量
npm run test:run       # 数值回归断言
npm run lint
```

4. 汇报时说明：改了哪张表、影响哪些配置、校验结果

## 不许绕过的关键不变量

以下约束会被 `npm run check-config` 硬拦截，**不要靠改校验代码来"通过"**：

| 不变量 | 数值 | 位置 |
|---|---|---|
| 盲盒概率合计 = 100% | 容差 1e-6 | `config/gacha.json` |
| 盲盒材料返还率 | 0.55 – 0.65 | `config/gacha.json` |
| 区域 dropRates 合计 = 100% | 容差 1e-6 | `config/zones.json` |
| 区域每体力收益增幅 | ≤ 10% | `config/zones.json` |
| 载具攒钱趟数 | 8 – 18 趟 | `config/vehicles.json` |
| 保底 / 新手保护生效 | 9 次未紫→第 10 次必紫 | `config/gacha.json` |

确需突破某条不变量时，必须先说明原因，并同步修改 `CODEBUDDY.md` 的「关键不变量」章节。

## 派生值为什么也要校验

`expectedMaterialValue`、`materialReturnRate`、`avgUnitValue` 这类列是 xlsx 的公式列。config 里保留它们，是为了让**配置本身自洽**：一旦有人改了概率却忘了改派生值，`check-config` 会立刻报错并指出是哪个盲盒 / 哪个区域。
