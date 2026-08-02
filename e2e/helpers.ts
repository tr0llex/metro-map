import { expect, type Page } from '@playwright/test';

/** Выбирает станцию в поле формы через список подсказок — как это делает человек. */
export async function pickStation(page: Page, label: string, query: string): Promise<void> {
  const field = page.getByLabel(label);
  await field.click();
  await field.fill(query);

  const first = page.locator('.suggestion-item').first();
  await expect(first).toBeVisible();
  await first.click();

  await expect(field).toHaveValue(query);
}

/**
 * Ждёт, пока схема реально появится на канвасе. Канвас существует в DOM с
 * первого кадра, поэтому его наличие ничего не доказывает — считаем непрозрачные
 * пиксели. Пустая схема (не загрузились данные, упала раскладка) даёт ноль.
 */
export async function mapPaintedPixels(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas.metro-map-svg');
    if (!canvas) return -1;
    const ctx = canvas.getContext('2d');
    if (!ctx || canvas.width === 0) return -1;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let painted = 0;
    // Шаг по пикселям, а не по каждому: полноразмерный канвас — это миллионы
    // значений, и точный счёт здесь не нужен, нужен факт «не пусто».
    for (let i = 3; i < data.length; i += 4 * 97) if (data[i] > 0) painted++;
    return painted;
  });
}

/**
 * Дожидается активного service worker и возвращает адрес его скрипта.
 *
 * Ждать здесь `controller` бесполезно: воркер не захватывает страницу, на
 * которой зарегистрировался, — первую загрузку он пропускает и берёт под
 * контроль только следующую навигацию. Её и делает офлайн-тест.
 */
export async function waitForServiceWorker(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return reg.active?.scriptURL ?? '';
  });
}
