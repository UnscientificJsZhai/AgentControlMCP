import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores([
    'node_modules/**',
    'dist/**',
    '.test-dist/**',
    'coverage/**',
    'doc/**',
    'tmp/**',
    'out-tsc/**',
    '.idea/**',
    '.vscode/**',
    '.eslintcache',
    '**/*.tsbuildinfo',
  ]),
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.node,
    },
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@modelcontextprotocol/**', '@agentclientprotocol/**'],
              message: '领域层不得导入 MCP/ACP SDK；请通过应用服务或适配器接入协议。',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            ':matches(ImportExpression, TSImportType)[source.value=/^@(modelcontextprotocol|agentclientprotocol)\\u002F/]',
          message: '领域层不得通过动态导入或导入类型引用 MCP/ACP SDK。',
        },
      ],
    },
  },
  eslintConfigPrettier,
]);
