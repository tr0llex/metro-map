import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // coverage — сгенерированный отчёт покрытия: там чужой минифицированный js
  // (prettify.js, sorter.js), и линтер ругался на него как на наш код.
  globalIgnores(['dist', 'dev-dist', 'dist-editor', 'coverage']),
  // .mjs не линтился вообще — включая scripts/check-prod-bundle.mjs, который
  // сторожит, что редактор не утёк в прод-бандл.
  {
    files: ['**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      // node + browser: часть .mjs — это Node-скрипты, но стенд визуальной
      // приёмки уезжает кусками кода в браузер через page.evaluate(), и там
      // законны document/window.
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      'react-hooks/set-state-in-effect': 'off',
    },
  },
  // Сквозные тесты — не React-код. Фикстура Playwright принимает колбэк с
  // параметром `use`, и правило hooks видит в его вызове React-хук вне
  // компонента: здесь оно не шумит, а запрещает штатный API библиотеки.
  {
    files: ['e2e/**/*.ts'],
    rules: {
      'react-hooks/rules-of-hooks': 'off',
    },
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
])
