import { defineConfig, devices } from '@playwright/test';

// Смоук по живому сайту. Запускается руками (`npm run e2e:prod`) — например,
// сразу после выкатки. В CI на каждый PR не висит: он проверяет прод, а не диф.
export default defineConfig({
  testDir: './e2e/prod',
  retries: 1,
  workers: 1,
  reporter: 'list',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: process.env.E2E_PROD_URL ?? 'https://metro.samoy.love',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
});
