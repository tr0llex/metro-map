import { defineConfig, devices } from '@playwright/test';

// Прогон идёт против ЛОКАЛЬНОЙ прод-сборки, а не против сайта: тест должен
// падать от изменений в этой ветке, а не от того, что сейчас на проде.
// Именно прод-сборка, а не dev: service worker и precache существуют только в ней.
const PORT = 4330;

// Смоук по проду живёт рядом, но в локальный прогон попадать не должен.
const PROD = /[\\/]prod[\\/]/;

// Единственный файл, который трогает service worker и Cache Storage. Отсюда
// всё устройство проектов ниже: он обязан идти в одиночку, остальные — нет.
const OFFLINE = /offline\.spec\.ts$/;

export default defineConfig({
  testDir: './e2e',
  testIgnore: PROD,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Офлайн-тест регистрирует service worker и наполняет Cache Storage на общем
  // origin — соседний воркер, открывший страницу в тот же момент, получил бы
  // её из чужого кеша. Раньше из-за этого весь набор шёл в ОДИН воркер, хотя
  // service worker трогает ровно один файл из пяти.
  //
  // Теперь изоляция точечная: офлайн-тест вынесен в отдельный проект, который
  // стартует только после остальных (dependencies ниже) и состоит из одного
  // файла — то есть по-прежнему идёт в одиночку. Остальные четыре файла к
  // service worker не притрагиваются и делятся между воркерами.
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },

  // Порядок проектов — это и есть изоляция service worker, см. комментарий к
  // workers. `desktop` идёт параллельно, `offline` — после него и один.
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: [PROD, OFFLINE],
    },
    {
      name: 'offline',
      use: { ...devices['Desktop Chrome'] },
      testMatch: OFFLINE,
      // Пока идёт desktop, никто не должен регистрировать service worker;
      // пока идёт offline, никто не должен открывать страницу.
      dependencies: ['desktop'],
    },
  ],

  webServer: {
    command: `npm run build && npm run preview -- --port ${PORT} --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
