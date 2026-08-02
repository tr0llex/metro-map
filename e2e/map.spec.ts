import { test, expect } from './guards';
import { mapPaintedPixels } from './helpers';

test.describe('схема метро', () => {
  test('отрисовывается на канвасе, а не остаётся пустой', async ({ page }) => {
    await page.goto('/');

    const canvas = page.locator('canvas.metro-map-svg');
    await expect(canvas).toBeVisible();

    // Канвас есть в DOM с первого кадра — доказательство даёт только краска.
    await expect.poll(() => mapPaintedPixels(page), {
      message: 'на канвасе схемы нет ни одного непрозрачного пикселя',
    }).toBeGreaterThan(20);

    // Подписи станций рисуются вторым слоем: пустой слой подписей — это схема
    // без единого названия, и сама по себе схема при этом «отрисована».
    const labels = page.locator('canvas.metro-map-labels');
    await expect(labels).toBeAttached();
    const labelBox = await labels.boundingBox();
    expect(labelBox?.width ?? 0).toBeGreaterThan(200);

    await expect(page.getByLabel('Приблизить карту')).toBeVisible();
    await expect(page.getByLabel('Отдалить карту')).toBeVisible();
  });

  test('зум перерисовывает схему', async ({ page }) => {
    await page.goto('/');
    await expect.poll(() => mapPaintedPixels(page)).toBeGreaterThan(20);

    const before = await page.evaluate(
      () => document.querySelector<HTMLCanvasElement>('canvas.metro-map-svg')!.toDataURL().length,
    );

    await page.getByLabel('Приблизить карту').click();

    // Перерисовка асинхронна: ждём по состоянию картинки, а не по таймеру.
    await expect
      .poll(
        () =>
          page.evaluate(
            () => document.querySelector<HTMLCanvasElement>('canvas.metro-map-svg')!.toDataURL().length,
          ),
        { message: 'после зума картинка на канвасе не изменилась' },
      )
      .not.toBe(before);
  });
});
