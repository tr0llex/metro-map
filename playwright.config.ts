import { defineConfig, devices } from '@playwright/test';

// Прогон идёт против ЛОКАЛЬНОЙ прод-сборки, а не против сайта: тест должен
// падать от изменений в этой ветке, а не от того, что сейчас на проде.
// Именно прод-сборка, а не dev: service worker и precache существуют только в ней.
const PORT = 4330;

// Смоук по проду живёт рядом, но в локальный прогон попадать не должен.
const PROD = /[\\/]prod[\\/]/;

export default defineConfig({
  testDir: './e2e',
  testIgnore: PROD,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Офлайн-тест регистрирует service worker на общем origin — параллельные
  // воркеры в этом случае мешают друг другу.
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },

  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'] }, testIgnore: PROD }],

  webServer: {
    command: `npm run build && npm run preview -- --port ${PORT} --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
