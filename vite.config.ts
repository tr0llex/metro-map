 import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import {
  ROUTING_GRAPH_ASSET_PATH,
  encodeRoutingGraph,
  type RoutingGraphSource,
} from './src/metro/routingGraphPayload.ts'
import { editorApiPlugin } from './scripts/editor/editorApiPlugin.ts'

/**
 * Отдаёт воркеру маршрутизации компактный граф отдельным ассетом.
 *
 * Воркер собирается Vite в отдельный rollup-бандл, поэтому общий чанк с главным
 * бандлом невозможен: статический импорт `normalized/fullGraph.json` в воркере
 * укладывал те же ~123 КБ данных в сборку второй раз. Здесь из исходных данных
 * собирается срез, нужный только для поиска маршрута (рёбра + id станций) —
 * это ~20 КБ, которые воркер подгружает на старте.
 *
 * Имя ассета фиксированное (без хеша), чтобы воркер знал его на этапе сборки;
 * актуальность обеспечивает Workbox — он кладёт файл в precache с revision-хешем
 * (для этого файл лежит в корне сборки, см. ROUTING_GRAPH_ASSET_PATH).
 */
function routingGraphAssetPlugin(): Plugin {
  const sourcePath = fileURLToPath(new URL('./normalized/fullGraph.json', import.meta.url))
  const buildPayload = () => {
    const raw = JSON.parse(readFileSync(sourcePath, 'utf8')) as RoutingGraphSource
    return JSON.stringify(encodeRoutingGraph(raw))
  }

  return {
    name: 'metro-map:routing-graph-asset',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0]
        if (path !== `/${ROUTING_GRAPH_ASSET_PATH}`) {
          next()
          return
        }
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-store')
        res.end(buildPayload())
      })
      server.watcher.add(sourcePath)
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: ROUTING_GRAPH_ASSET_PATH,
        source: buildPayload(),
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const isEditorBuild = mode === 'editor'
  const isPwaDev = mode === 'pwa'
  const indexHtml = fileURLToPath(new URL('./index.html', import.meta.url))
  const editorHtml = fileURLToPath(new URL('./editor.html', import.meta.url))
  const projectRoot = fileURLToPath(new URL('.', import.meta.url))

  return {
    plugins: [
      react(),
      routingGraphAssetPlugin(),
      // Запись правок редактора в data/. `apply: 'serve'` внутри плагина не
      // пускает его в сборку, но и подключаем его только там, где он нужен.
      editorApiPlugin(projectRoot),
      VitePWA({
        registerType: 'prompt',
        includeAssets: [
          'metro-icon.svg',
          'metro-icon-maskable.svg',
          'apple-touch-icon-180x180.png',
          'pwa-64x64.png',
          'pwa-192x192.png',
          'pwa-512x512.png',
          'maskable-icon-512x512.png',
        ],
        filename: 'metro-map-sw.js',
        manifestFilename: 'metro-map-manifest.webmanifest',
        devOptions: {
          enabled: isPwaDev,
          type: 'module',
          suppressWarnings: true,
        },
        manifest: {
          id: '/',
          scope: '/',
          name: 'Метро Москвы — схема и маршруты',
          short_name: 'Метро Москвы',
          description:
            'Офлайн-схема московского метро: маршруты, пересадки и время в пути. Работает без интернета.',
          theme_color: '#f7f8fa',
          background_color: '#f7f8fa',
          display: 'standalone',
          orientation: 'portrait-primary',
          lang: 'ru-RU',
          start_url: '/',
          icons: [
            {
              src: '/pwa-64x64.png',
              sizes: '64x64',
              type: 'image/png',
            },
            {
              src: '/pwa-192x192.png',
              sizes: '192x192',
              type: 'image/png',
            },
            {
              src: '/pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/maskable-icon-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          // json обязателен: граф маршрутизации лежит отдельным ассетом
          // assets/metro-map-routing-graph.json, и без него офлайн-режим
          // не сможет построить ни одного маршрута.
          globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest,json}'],
          cleanupOutdatedCaches: true,
          // Никаких skipWaiting/clientsClaim: при registerType: 'prompt' новый SW
          // должен ждать явного подтверждения пользователя в баннере обновления,
          // иначе версия меняется посреди сессии и уже загруженные lazy-чанки дают 404.
        },
      }),
    ],
    test: {
      // Модульные тесты — это `*.test.ts` в src/ и scripts/, и только они.
      // Список задан явно, а не оставлен на умолчание vitest: шаблон по
      // умолчанию ловит ещё и `*.spec.ts`, а значит забирает сквозные тесты из
      // e2e/. Playwright-спеки в раннере vitest не запускаются вовсе — они
      // падают на `test.describe()` ещё при сборе файла, — и шесть таких
      // «упавших наборов» роняли весь прогон.
      include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.{ts,tsx}'],
      // .claude/worktrees — временные копии репозитория, которые создают
      // фоновые агенты. Vitest подхватывал оттуда УСТАРЕВШИЕ копии тестов:
      // 88 из 219 «пройденных» тестов приходили из чужого worktree, то есть
      // число было завышено, а зелёный статус частично относился к старому коду.
      exclude: ['**/node_modules/**', '**/dist/**', '**/dist-editor/**', '.claude/**'],
      coverage: {
        provider: 'v8',
        // lcov — для Codecov, text — чтобы цифра была видна прямо в логе CI.
        reporter: ['text', 'lcov'],
        include: ['src/**/*.{ts,tsx}'],
        // Точки входа и типы: в них нечего покрывать, а знаменатель они портят.
        //
        // Сами тесты исключены отдельной строкой, и это не косметика: без неё
        // v8 считал `*.test.ts` за исходники. Тест исполняется целиком, то есть
        // приходит в отчёт со своими ~100%, и общая цифра росла ровно от того,
        // что тестов стало больше — независимо от того, покрыли они хоть строчку
        // продакшн-кода или нет.
        exclude: [
          'src/**/*.d.ts',
          'src/main.tsx',
          'src/editor-main.tsx',
          'src/vite-env.d.ts',
          'src/**/*.test.{ts,tsx}',
          'src/**/__tests__/**',
        ],
      },
    },
    build: {
      outDir: isEditorBuild ? 'dist-editor' : 'dist',
      rollupOptions: {
        input: isEditorBuild ? editorHtml : indexHtml,
        output: {
          manualChunks(id) {
            const p = id.split('\\').join('/')

            if (p.includes('/node_modules/')) {
              if (p.includes('/react/') || p.includes('/react-dom/')) return 'react'
              return 'vendor'
            }

            if (p.includes('/src/metro/')) return 'metro'

            if (p.includes('/src/components/MetroMap')) return 'map'

            if (isEditorBuild && p.includes('/src/components/HubEditorPanel')) {
              return 'editor'
            }

            return undefined
          },
          entryFileNames: 'assets/metro-map-[name]-[hash].js',
          chunkFileNames: 'assets/metro-map-[name]-[hash].js',
          assetFileNames: 'assets/metro-map-[name]-[hash][extname]',
        },
      },
    },
  }
})
