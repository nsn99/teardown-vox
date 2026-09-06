import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Линтер намеренно скромный.
 *
 * Основную работу делают строгие типы и тесты; линтеру оставлено то, что
 * они не ловят: мёртвые переменные, случайные `any`, забытые промисы.
 * Правила стиля не включены осознанно — спорить о кавычках в проекте из
 * одного человека дороже, чем любая польза от этого спора.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'shots/**',
      'packages/*/dist/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      // Неиспользованное — это либо забытый код, либо опечатка. Подчёркивание
      // впереди — явное «я знаю, что не использую».
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // `any` в физическом ядре — это дыра в типах, из которой потом лезут
      // NaN-ы в координатах.
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['warn', { allow: ['warn', 'error', 'log'] }],
    },
  },
  {
    // Инструменты и прогоны — обычный ES-код на Node, без типов.
    files: ['tools/**/*.mjs', '*.config.js'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        performance: 'readonly',
        URL: 'readonly',
        // Внутри page.evaluate код исполняется в браузере, а не в Node.
        window: 'readonly',
        document: 'readonly',
      },
    },
    rules: {
      // Русский текст в шаблонных строках содержит неразрывные пробелы,
      // и это осознанно: «12 мс» не должно переноситься по пробелу.
      'no-irregular-whitespace': ['error', { skipTemplates: true, skipStrings: true }],
    },
  },
);
