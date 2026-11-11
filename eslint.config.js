import { globalIgnores } from 'eslint/config'
import { defineConfigWithVueTs, vueTsConfigs } from '@vue/eslint-config-typescript'
import pluginVue from 'eslint-plugin-vue'
import skipFormatting from '@vue/eslint-config-prettier/skip-formatting'

export default defineConfigWithVueTs(
  { name: 'canvas/files', files: ['**/*.{ts,mts,mjs,vue}'] },
  globalIgnores(['dist/**', 'web/public/**']),
  pluginVue.configs['flat/recommended'],
  vueTsConfigs.recommended,
  {
    name: 'canvas/rules',
    rules: {
      // A leading underscore marks a value that is deliberately dropped.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      // A handle may be declared before the callbacks that close over it.
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
      // Optional props are typed; `undefined` is their default.
      'vue/require-default-prop': 'off',
    },
  },
  skipFormatting,
)
