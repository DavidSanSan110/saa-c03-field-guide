// @ts-check
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores([
    '**/dist/',
    '**/coverage/',
    '**/.astro/',
    'playwright-report/',
    'test-results/',
    'private/',
    '.claude/',
  ]),
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // CloudFront Functions are plain scripts: no import or export, and the runtime calls the global
    // `handler`, which nothing in the file uses.
    files: ['labs/*/functions/*.js'],
    languageOptions: { sourceType: 'script' },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^handler$' }],
      // typescript-eslint turns the base rule off everywhere and enables its own copy instead.
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  prettier,
);
