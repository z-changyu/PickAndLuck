---
description: src/core/ 是纯逻辑层，禁止引用任何渲染库、DOM API、平台 SDK
alwaysApply: true
---

# 核心逻辑层纯净性（src/core/）

`src/core/` 是全项目最重要的资产：它必须能在**纯 Node 环境**下跑单测，并在阶段二原样搬进 Cocos Creator。

## 硬性禁止

`src/core/` 与 `src/config/` 下的任何文件，**不得**出现：

1. 渲染库 / 平台 SDK 的 import：`pixi.js`、`@pixi/*`、`cc`（Cocos）、`wx`（微信小游戏）、`three` 等。
2. DOM / BOM API：`window`、`document`、`localStorage`、`navigator`、`fetch`、`XMLHttpRequest`、`requestAnimationFrame`、`Image` 等。
3. 从上层目录 import：`../render/*`、`../scenes/*`、`../ui/*`、`../debug/*`。
4. 直接调用 `Math.random()`（必须走 `src/core/rng.ts` 的种子随机）。

## 允许的依赖

- `src/core/**` 内部互相引用
- `src/config/**`（纯类型与校验，无渲染依赖）
- 纯计算类 npm 包（引入前需确认无 DOM 依赖）

## 如何验证

```bash
npm run lint       # no-restricted-imports / no-restricted-globals 会报错
npm run typecheck  # tsconfig.core.json 无 DOM lib，window/document 直接编译失败
```

新增 core 模块后，如果 lint 或 typecheck 报错，**修代码，不是改规则**。
确需放宽约束时，必须先说明理由并同步修改本文件与 `CODEBUDDY.md`。
