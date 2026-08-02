import { test, expect } from './guards';
import { pickStation } from './helpers';

test.describe('построение маршрута', () => {
  test('пара станций с пересадкой даёт маршрут со временем, пересадкой и списком станций', async ({
    page,
  }) => {
    await page.goto('/');

    await pickStation(page, 'Станция отправления', 'Юго-Западная');
    await pickStation(page, 'Станция назначения', 'Медведково');

    // Маршрут считает воркер: ждём готовый результат, а не «прошло N секунд».
    const summary = page.locator('.route-summary-main');
    await expect(summary).toBeVisible();

    // Время должно быть числом минут, а не прочерком или NaN.
    const time = page.locator('.summary-time');
    await expect(time).toHaveText(/^\d+ мин$/);
    expect(Number((await time.textContent())!.replace(/\D/g, ''))).toBeGreaterThan(0);

    await expect(page.locator('.summary-arrival')).toHaveText(/^Прибытие ~\d{1,2}:\d{2}$/);
    await expect(page.locator('.summary-transfers')).toHaveText(/пересадк/);

    // Ради этого маршрут и строят: где выйти и на что пересесть.
    const transfer = page.locator('.route-step--transfer');
    await expect(transfer).toHaveCount(1);
    await expect(transfer.locator('.step-title')).toHaveText(/^Пересадка: .+ → .+$/);

    // Отрезки поездки перечисляют станции — пустой список означает, что
    // маршрут «есть», но проехать по нему нельзя.
    const rides = page.locator('.route-step:not(.route-step--transfer)');
    await expect(rides).toHaveCount(2);
    await expect(rides.first().locator('.step-station-item')).not.toHaveCount(0);
    await expect(rides.first().locator('.step-station-name').first()).toHaveText('Юго-Западная');
    await expect(rides.last().locator('.step-station-name').last()).toHaveText('Медведково');

    // Объявление для скринридера — единственное место, где итог сформулирован
    // словами; если оно разъехалось с карточкой, разъехалось что-то одно.
    await expect(page.locator('.route-loading-live')).toHaveText(
      /Маршрут построен: Юго-Западная — Медведково\. \d+ минут.*, \d+ пересадк/,
    );
  });

  test('альтернативные варианты переключаются и меняют маршрут', async ({ page }) => {
    await page.goto('/');

    await pickStation(page, 'Станция отправления', 'Комсомольская');
    await pickStation(page, 'Станция назначения', 'Юго-Западная');

    const chips = page.locator('.route-choice-chip');
    // Смысл альтернатив в том, что их больше одной.
    await expect.poll(() => chips.count()).toBeGreaterThan(1);

    const time = page.locator('.summary-time');
    const firstTime = await time.textContent();

    // Берём вариант с пересадками — проверяем, что переключение перестраивает
    // не только подсветку чипа, но и сам маршрут.
    const withTransfers = chips.filter({ hasText: /пересадк/ }).first();
    await withTransfers.click();

    await expect(withTransfers).toHaveClass(/bottom-route-chip--active/);
    await expect(time).not.toHaveText(firstTime!);
    await expect(page.locator('.summary-transfers')).toHaveText(/\d+ пересадк/);
    await expect(page.locator('.route-step--transfer')).not.toHaveCount(0);
  });

  test('станции меняются местами кнопкой обмена', async ({ page }) => {
    await page.goto('/');

    await pickStation(page, 'Станция отправления', 'Комсомольская');
    await pickStation(page, 'Станция назначения', 'Юго-Западная');
    await expect(page.locator('.summary-time')).toBeVisible();

    await page.getByLabel('Поменять местами станции Откуда и Куда').click();

    await expect(page.getByLabel('Станция отправления')).toHaveValue('Юго-Западная');
    await expect(page.getByLabel('Станция назначения')).toHaveValue('Комсомольская');
    // Обратный маршрут должен пересчитаться, а не остаться от прошлого запроса.
    await expect(page.locator('.route-loading-live')).toHaveText(
      /Маршрут построен: Юго-Западная — Комсомольская/,
    );
  });
});
