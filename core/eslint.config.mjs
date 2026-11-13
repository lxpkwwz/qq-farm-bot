import antfu from '@antfu/eslint-config'

export default antfu(
  {
    type: 'app',
    typescript: {
      tsconfigPath: './tsconfig.json',
      // client.ts 是根目录入口，不在 tsconfig 的 include（src/**）里；
      // 类型感知只覆盖 src，根目录入口仍走普通 lint，否则 project service 会直接报错。
      filesTypeAware: ['src/**/*.ts'],
      // 只保留「未处理 Promise」这一族规则，其余类型感知规则（no-unsafe-* 等）
      // 在 non-strict 代码库上噪声过大，逐条关掉。
      overridesTypeAware: {
        'ts/await-thenable': 'error',
        'ts/no-floating-promises': 'error',
        // 只查「Promise 被当作 void 回调传出去」（定时器 / 事件 / 回调），
        // 不查 `if (pendingPromise)` 这类「Promise 当哨兵」的合法写法。
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
    stylistic: false,
    yaml: false,
    jsonc: false,
    markdown: false,
    formatters: false,
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: false,
    },
    rules: {
      'no-console': 'off',
      'no-use-before-define': 'off',
      'perfectionist/sort-imports': 'off',
      'ts/consistent-type-definitions': 'off',
      'ts/consistent-type-imports': 'off',
      'ts/no-explicit-any': 'off',
      'ts/no-require-imports': 'off',
      'node/prefer-global/buffer': 'off',
      'node/prefer-global/process': 'off',
      'unicorn/prefer-module': 'off',
      'unicorn/prefer-node-protocol': 'off',
    },
  },
)
