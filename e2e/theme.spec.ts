import { test, expect } from './guards';
import { mapPaintedPixels } from './helpers';

// Переключатель темы — одна кнопка, и на ней написана ЦЕЛЬ, а не текущее
// состояние (см. src/components/ThemeToggle.tsx). Поэтому искать её надо по
// подписи желаемой темы, и после каждого нажатия подпись меняется на обратную.
const toDark = 'Включить тёмную тему';
const toLight = 'Включить светлую тему';

test.describe('тема оформления', () => {
  // Пока кнопку не трогали, тема берётся у системы, и от системной темы зависит
  // подпись на кнопке. Фиксируем светлую, иначе первый шаг сценария зависел бы
  // от настроек машины, на которой идёт прогон.
  test.use({ colorScheme: 'light' });

  test('переключается и переживает перезагрузку', async ({ page }) => {
    await page.goto('/');

    const root = page.locator('html');

    // Режим «как в системе» атрибут не ставит вовсе — он и есть его отсутствие.
    await expect(page.getByLabel(toDark)).toBeVisible();
    await expect(root).not.toHaveAttribute('data-theme', /.*/);

    await page.getByLabel(toDark).click();
    await expect(root).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByLabel(toLight)).toBeVisible();

    // Схема перерисовывается под тему: если этого не произошло, светлые
    // подписи останутся на светлом фоне — страница «работает» и нечитаема.
    await expect.poll(() => mapPaintedPixels(page)).toBeGreaterThan(20);

    // Выбор темы — настройка, а не разовое действие: после перезагрузки он
    // обязан сохраниться, иначе приложение каждый раз спорит с пользователем.
    await page.reload();
    await expect(root).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByLabel(toLight)).toBeVisible();

    // Обратный путь тоже должен работать: тёмная тема не ловушка.
    await page.getByLabel(toLight).click();
    await expect(root).toHaveAttribute('data-theme', 'light');
  });

  test('цвет статус-бара следует за темой', async ({ page }) => {
    await page.goto('/');

    const themeColor = () =>
      page.evaluate(
        () => document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? '',
      );

    await page.getByLabel(toDark).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const dark = await themeColor();

    await page.getByLabel(toLight).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect.poll(themeColor, { message: 'meta theme-color не изменился' }).not.toBe(dark);
  });
});
