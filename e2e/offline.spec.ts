import { test, expect } from './guards';
import { mapPaintedPixels, waitForServiceWorker } from './helpers';

// Офлайн — не приятное дополнение, а обещание в названии проекта. Проверить его
// можно только фактически: зарегистрировать воркер, выдернуть сеть и зайти ещё раз.
test.describe('офлайн', () => {
  test('service worker регистрируется и повторный заход без сети отдаёт приложение', async ({
    page,
    context,
    problems,
  }) => {
    await page.goto('/');

    const script = await waitForServiceWorker(page);
    expect(script, 'service worker не активировался').toMatch(/kitty-metro-sw\.js$/);

    // Дожидаемся, пока precache доедет: без этого «офлайн работает» означало бы
    // лишь «успели закэшировать первые файлы».
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const names = await caches.keys();
            let total = 0;
            for (const name of names) total += (await (await caches.open(name)).keys()).length;
            return total;
          }),
        { message: 'кэш service worker остался пустым', timeout: 30_000 },
      )
      .toBeGreaterThan(10);

    await context.setOffline(true);
    try {
      await page.reload();

      // Без сети приложение обязано подняться целиком, а не показать оболочку.
      //
      // Схему ищем по канвасу, как и в map.spec.ts. По подписи «Схема метро
      // Москвы» её найти нельзя: тем же именем помечен пустой <main>-распорка
      // оверлея, и getByLabel сравнивает подстрокой — под условие попадали оба
      // элемента сразу, что строгий режим Playwright справедливо считает ошибкой
      // теста, а не приложения.
      await expect(page.locator('canvas.metro-map-svg')).toBeVisible();
      await expect(page.getByLabel('Станция отправления')).toBeVisible();
      await expect
        .poll(() => mapPaintedPixels(page), { message: 'без сети схема не отрисовалась' })
        .toBeGreaterThan(20);
    } finally {
      // Контекст переиспользуется — офлайн нужно снять при любом исходе.
      await context.setOffline(false);
    }

    // В офлайне запрос уходит в сеть только тогда, когда ответа нет в кэше, —
    // то есть каждый провал здесь и есть дырка в офлайне. Единственное
    // исключение: браузер сам ходит проверять обновление скрипта воркера.
    const unserved = problems.network.filter((entry) => !/kitty-metro-sw\.js/.test(entry));
    expect(unserved, 'без сети эти запросы не нашлись в кэше').toEqual([]);
    problems.network.length = 0;
  });
});
