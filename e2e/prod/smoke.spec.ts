import { test, expect } from '../guards';
import { mapPaintedPixels, pickStation, waitForServiceWorker } from '../helpers';

test('прод отдаёт живое приложение, а не просто 200', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByLabel('Схема метро Москвы')).toBeVisible();
  await expect
    .poll(() => mapPaintedPixels(page), { message: 'на проде схема не отрисовалась' })
    .toBeGreaterThan(20);

  await pickStation(page, 'Станция отправления', 'Юго-Западная');
  await pickStation(page, 'Станция назначения', 'Медведково');

  await expect(page.locator('.summary-time')).toHaveText(/^\d+ мин$/);
  await expect(page.locator('.route-step--transfer')).toHaveCount(1);
});

test('на проде регистрируется service worker', async ({ page }) => {
  await page.goto('/');
  const script = await waitForServiceWorker(page);
  expect(script, 'на проде service worker не взял страницу под контроль').toMatch(
    /metro-map-sw\.js$/,
  );
});
