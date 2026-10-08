---
description: src/ 下禁止魔法数字，所有游戏数值必须来自 config/
alwaysApply: true
---

# 禁止魔法数字

## 规则

`src/` 下的任何**游戏数值**都必须从 `config/` 读取，不得硬编码在代码里。

反面例子：

```ts
if (money > 100) { ... }                 // ✗ 100 是什么？改平衡要翻遍全项目
const price = gridCount * 1.5            // ✗ 1.5 应该是配置项
if (streak >= 10) { guarantee() }        // ✗ 保底次数必须来自 gacha.json 的 pity 段
```

正面例子：

```ts
const { price } = config.gacha.boxes[boxId]        // ✓
if (streak >= config.gacha.pity.purpleGuaranteeCounter) { guarantee() }  // ✓
```

## 例外

以下数字**不算**魔法数字，可以内联：

- 数组下标、`0` / `1` 这类语言层面的常量
- `Math.abs(x) < 1e-6` 之类的浮点容差（建议统一定义在 `src/config/` 的常量里）
- 纯渲染参数：像素尺寸、缓动时长、颜色值 —— 这些属于渲染层，放在 `src/render/`、`src/ui/` 的本地常量文件里

## 判定方法

问自己：**"策划改了这个数字，我是不是要改代码？"**
答案是"要"，那它就必须进 `config/`。

## 改数值的流程

1. 改 `design/捡漏_数值框架.xlsx`
2. 同步 `config/*.json`
3. 跑 `npm run check-config` 与 `npm run test:run`
4. 违反关键不变量的改动会被配置校验直接拦下
