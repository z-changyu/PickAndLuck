import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

/**
 * 纯逻辑层（src/core、src/config）绝对不允许出现的依赖。
 * 见 .codebuddy/rules/core-purity.md —— 这条约束是「逻辑层能在阶段二原样搬进 Cocos」的前提。
 */
const CORE_FORBIDDEN_IMPORTS = [
  // 渲染库 / 平台 SDK
  'pixi.js',
  'pixi.js/**',
  '@pixi/**',
  'three',
  'three/**',
  'cc',
  'cc/**', // Cocos Creator
  'wx',
  'wx/**', // 微信小游戏
  // 上层目录（核心层不许反向依赖渲染层）
  '../render/**',
  '../scenes/**',
  '../ui/**',
  '../debug/**',
  '**/render/**',
  '**/scenes/**',
  '**/ui/**',
  '**/debug/**',
]

const CORE_FORBIDDEN_GLOBALS = [
  'window',
  'document',
  'localStorage',
  'sessionStorage',
  'navigator',
  'location',
  'history',
  'screen',
  'alert',
  'confirm',
  'prompt',
  'fetch',
  'XMLHttpRequest',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'Image',
]

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'design/**', '.codebuddy/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },

  {
    files: ['**/*.ts'],
    rules: {
      // CODEBUDDY.md：禁止 any、禁止 @ts-ignore
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-ignore': true,
          'ts-nocheck': true,
          'ts-check': false,
          'ts-expect-error': 'allow-with-description',
        },
      ],
    },
  },

  // ★ 硬约束 1：所有随机必须走 core/rng.ts 的种子随机
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message:
            '禁止直接使用 Math.random()：请通过 src/core/rng.ts 的种子随机（见 CODEBUDDY.md 关键约束 3）',
        },
      ],
    },
  },

  // ★ 硬约束 2：src/core 与 src/config 必须保持纯逻辑
  {
    files: ['src/core/**/*.ts', 'src/config/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: CORE_FORBIDDEN_IMPORTS,
              message:
                'src/core 与 src/config 是纯逻辑层，禁止引用渲染库 / 平台 SDK / 上层目录（见 .codebuddy/rules/core-purity.md）',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        ...CORE_FORBIDDEN_GLOBALS.map((name) => ({
          name,
          message: `纯逻辑层禁止使用 DOM / BOM 全局 "${name}"（见 .codebuddy/rules/core-purity.md）`,
        })),
      ],
    },
  },
)
