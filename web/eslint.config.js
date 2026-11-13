import antfu from '@antfu/eslint-config'

export default antfu(
  {
    vue: true,
    typescript: {
      tsconfigPath: './tsconfig.app.json',
      // 只保留「未处理 Promise」这一族规则；其余类型感知规则在现有代码库上噪声过大。
      overridesTypeAware: {
        'ts/await-thenable': 'error',
        'ts/no-floating-promises': 'error',
        'ts/no-misused-promises': ['error', { checksConditionals: false, checksSpreads: false }],
        'ts/no-for-in-array': 'off',
        'ts/no-unnecessary-type-assertion': 'off',
        'ts/no-unsafe-argument': 'off',
        'ts/no-unsafe-assignment': 'off',
        'ts/no-unsafe-call': 'off',
        'ts/no-unsafe-member-access': 'off',
        'ts/no-unsafe-return': 'off',
        'ts/promise-function-async': 'off',
        'ts/restrict-plus-operands': 'off',
        'ts/restrict-template-expressions': 'off',
        'ts/return-await': 'off',
        'ts/strict-boolean-expressions': 'off',
        'ts/switch-exhaustiveness-check': 'off',
        'ts/unbound-method': 'off',
      },
    },
    unocss: true,
    formatters: true,
    rules: {
      'no-alert': 'off',
    },
  },
  {
    // 本仓库的单测统一用 node:test（`node --test tests/*.test.mjs`），不接 vitest；
    // 且常靠 new Function / vm 把 TS 源码跑起来做静态断言，这里没有代码注入面。
    files: ['tests/**'],
    rules: {
      'test/no-import-node-test': 'off',
      'no-new-func': 'off',
    },
  },
)
