import { test, expect } from './guards';
import { pickStation } from './helpers';
import type { Page } from '@playwright/test';

/**
 * Перетаскивание нижней шторки пальцем.
 *
 * Тест обязан пользоваться НАСТОЯЩИМ тач-вводом браузера, а не событиями,
 * созданными в странице. Вся суть проверки — гонка за жест между нами и
 * прокруткой браузера: он решает, чей это жест, по touch-action и по тому,
 * успели ли мы отменить событие. TouchEvent, собранный руками в JS, никакой
 * прокрутки не запускает и потому проходит даже на сломанном коде. Отсюда
 * CDP: Input.dispatchTouchEvent идёт тем же путём, что и палец.
 */
test.use({ viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true });

type Cdp = { send: (method: string, params?: unknown) => Promise<unknown> };

/**
 * Проводит пальцем по вертикали из точки (x, y) на dy пикселей — СПОКОЙНО.
 *
 * Пауза между шагами здесь принципиальна. Без неё весь жест приходит за один
 * кадр, скорость выходит запредельной и срабатывает отдельная ветка «флик»,
 * которая раскрывала шторку и до правки. Проверять надо обычное осмысленное
 * движение: 20px за кадр — примерно так человек и тянет.
 */
async function swipe(
  page: Page,
  cdp: Cdp,
  start: { x: number; y: number },
  dy: number,
): Promise<void> {
  const point = (y: number) => [{ x: start.x, y, radiusX: 12, radiusY: 12, force: 1 }];
  const steps = Math.max(6, Math.round(Math.abs(dy) / 20));

  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(start.y) });
  for (let i = 1; i <= steps; i += 1) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: point(start.y + (dy * i) / steps),
    });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** Ход шторки в пикселях: раскрытая высота минус всегда видимая часть. */
async function sheetRange(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.bottom-sheet');
    const min = document.querySelector<HTMLElement>('.bottom-sheet-min');
    return (el?.getBoundingClientRect().height ?? 0) - (min?.getBoundingClientRect().height ?? 0);
  });
}

/** Насколько шторка поднята: 0 — свёрнута, 1 — раскрыта полностью. */
async function sheetProgress(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.bottom-sheet');
    if (!el) return -1;
    const height = el.getBoundingClientRect().height;
    if (height <= 0) return -1;
    const matrix = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    const min = document.querySelector<HTMLElement>('.bottom-sheet-min');
    const range = height - (min?.getBoundingClientRect().height ?? 0);
    if (range <= 0) return -1;
    // translateY = (1 - progress) * range
    return 1 - matrix.m42 / range;
  });
}

/**
 * Ручка построенного маршрута.
 *
 * Ждать `.bottom-sheet-handle` было нельзя: полоска с этим классом стоит в
 * шторке с загрузки страницы, ещё до всякого маршрута. Ожидание проходило
 * мгновенно и не ждало ничего — тесты шли мерить шторку, пока маршрут ещё
 * считался в воркере, и держались на том, что расчёт успевает раньше.
 *
 * Отличает состояние не класс, а роль с именем: кнопкой ручка становится
 * ровно тогда, когда есть что раскрывать. Детали маршрута для ожидания не
 * годятся — у свёрнутой шторки они скрыты (visibility: hidden), и toBeVisible
 * на них не дождётся никогда.
 */
const routeHandle = (page: Page) => page.getByRole('button', { name: /детали маршрута/ });

async function buildRoute(page: Page): Promise<void> {
  await page.goto('/');
  await pickStation(page, 'Станция отправления', 'Юго-Западная');
  await pickStation(page, 'Станция назначения', 'Медведково');
  await expect(routeHandle(page)).toBeVisible();
}

test.describe('шторка маршрута тянется пальцем', () => {
  /**
   * Ради этого тест и написан.
   *
   * Решение «оставить раскрытой или вернуть» принималось по абсолютному
   * положению (progress >= 0.5). Ход шторки — около 575px на экране в 915px,
   * то есть открыть её пальцем можно было, только протащив 288px: треть
   * экрана. Движение на 120px шторка отыгрывала за пальцем и возвращала
   * обратно — со стороны это ровно «пальцем не поднимается, только нажатием».
   *
   * 120px — заведомо меньше половины любого разумного хода, поэтому тест
   * проверяет именно порог, а не подгоняется под конкретную высоту шторки.
   */
  test('спокойное движение вверх на 120px раскрывает шторку', async ({ page, context }) => {
    const cdp = (await context.newCDPSession(page)) as unknown as Cdp;
    await buildRoute(page);

    expect(await sheetProgress(page)).toBeLessThan(0.1);
    // Если ход вдруг стал коротким, тест перестал бы проверять порог.
    expect(await sheetRange(page)).toBeGreaterThan(300);

    // Хватаемся за тело шторки, а не за ручку: тянуть можно откуда угодно.
    const grab = (await page.locator('.bottom-route-summary-wrapper').boundingBox())!;
    await swipe(page, cdp, { x: grab.x + grab.width / 2, y: grab.y + grab.height / 2 }, -120);

    await expect.poll(() => sheetProgress(page), { timeout: 5000 }).toBeGreaterThan(0.9);
  });

  test('спокойное движение вниз на 120px сворачивает шторку', async ({ page, context }) => {
    const cdp = (await context.newCDPSession(page)) as unknown as Cdp;
    await buildRoute(page);

    await routeHandle(page).click();
    await expect.poll(() => sheetProgress(page), { timeout: 5000 }).toBeGreaterThan(0.9);

    const box = (await page.locator('.bottom-sheet').boundingBox())!;
    await swipe(page, cdp, { x: box.x + box.width / 2, y: box.y + 24 }, 120);

    await expect.poll(() => sheetProgress(page), { timeout: 5000 }).toBeLessThan(0.1);
  });

  /**
   * Обратная сторона низкого порога: случайный микросдвиг пальца не должен
   * распахивать шторку. Ось жеста распознаётся с 6px, поэтому проверяем
   * промежуток между «это уже жест» и «это уже намерение».
   */
  test('короткое движение на 24px оставляет шторку на месте', async ({ page, context }) => {
    const cdp = (await context.newCDPSession(page)) as unknown as Cdp;
    await buildRoute(page);

    const grab = (await page.locator('.bottom-route-summary-wrapper').boundingBox())!;
    await swipe(page, cdp, { x: grab.x + grab.width / 2, y: grab.y + grab.height / 2 }, -24);

    await expect.poll(() => sheetProgress(page), { timeout: 5000 }).toBeLessThan(0.1);
  });

  /** Ручка работала и до правки — следим, чтобы не сломалась заодно. */
  test('ручка по-прежнему открывает шторку нажатием', async ({ page }) => {
    await buildRoute(page);
    await routeHandle(page).click();
    await expect.poll(() => sheetProgress(page), { timeout: 5000 }).toBeGreaterThan(0.9);
  });
});
