/**
 * 《捡漏》核心逻辑层（纯 TS，零引擎依赖）。
 *
 * 本目录下所有模块必须遵守：
 *   1. 禁止 import 任何渲染库 / 平台 SDK（PixiJS、Cocos、微信 API…）
 *   2. 禁止使用 DOM API（window / document / localStorage…）
 *   3. 禁止直接使用 Math.random()，随机一律走 rng.ts
 *   4. 所有游戏数值必须从 config/ 读取，禁止魔法数字
 *
 * 以上 1~2 条由 `npm run lint` 与 `tsconfig.core.json` 强制；
 * 3~4 条由 .codebuddy/rules/ 下的规则与单测约束。
 *
 * 依赖方向（只许向下）：
 *   config/*  →  rng  →  pickup  →  { economy, inventory }
 *   config/*  →  progression
 *
 * 阶段二搬进 Cocos 时本目录原样复制，只替换 render / scenes。
 */
export * from './rng'
export * from './economy'
export * from './pickup'
export * from './inventory'
export * from './progression'
export * from './gacha'
export * from './save'
export * from './analytics'
