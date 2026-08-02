import { test, expect } from './guards';
import { mapPaintedPixels } from './helpers';

test.describe('тема оформления', () => {
  test('переключается и переживает перезагрузку', async ({ page }) => {
    await page.goto('/');

    const root = page.locator('html');

    await page.getByLabel('Тема: светлая').click();
    await expect(root).toHaveAttribute('data-theme', 'light');
    await expect(page.getByLabel('Тема: светлая')).toHaveAttribute('aria-pressed', 'true');

    await page.getByLabel('Тема: тёмная').click();
    await expect(root).toHaveAttribute('data-theme', 'dark');

    // Схема перерисовывается под тему: если этого не произошло, светлые
    // подписи останутся на светлом фоне — страница «работает» и нечитаема.
    await expect.poll(() => mapPaintedPixels(page)).toBeGreaterThan(20);

    // Выбор темы — настройка, а не разовое действие: после перезагрузки он
    // обязан сохраниться, иначе приложение каждый раз спорит с пользователем.
    await page.reload();
    await expect(root).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByLabel('Тема: тёмная')).toHaveAttribute('aria-pressed', 'true');
  });

  test('цвет статус-бара следует за темой', async ({ page }) => {
    await page.goto('/');

    const themeColor = () =>
      page.evaluate(
        () => document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? '',
      );

    await page.getByLabel('Тема: тёмная').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const dark = await themeColor();

    await page.getByLabel('Тема: светлая').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect.poll(themeColor, { message: 'meta theme-color не изменился' }).not.toBe(dark);
  });
});
