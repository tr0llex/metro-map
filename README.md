# Метро Москвы

Русский · [English](README.en.md)

[![CI](https://github.com/samoy-love/metro-map/actions/workflows/ci.yml/badge.svg)](https://github.com/samoy-love/metro-map/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/samoy-love/metro-map/branch/main/graph/badge.svg)](https://codecov.io/gh/samoy-love/metro-map)
[![прод](https://img.shields.io/website?url=https%3A%2F%2Fmetro.samoy.love&up_message=online&up_color=2ea043&down_message=offline&label=metro.samoy.love)](https://metro.samoy.love)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Офлайн-PWA для построения маршрутов по московскому метро — для тех, кому схема
нужна под землёй, где сети нет:
**[metro.samoy.love](https://metro.samoy.love)**, поставил один раз и дальше
работает с выключенным соединением.

Маршрут построит любое приложение метро. Хорошо нарисовать схему — почти
никакое. Схема метро — не карта: это сознательная ложь о географии,
рассказанная так, чтобы человек на платформе прочитал её за три секунды.
Правила этой лжи давние и вполне конкретные — линии идут кратно 45°, кольца
гладкие, станции одной пересадки сливаются в общий узел, и каждая подпись
обязана читаться, ничего не перекрывая. Здесь эти правила и есть продукт;
маршрутизация — простая половина.

| Вся схема | Маршрут | Пересадочный узел |
|---|---|---|
| ![Вся схема](docs/screenshots/overview.webp) | ![Маршрут](docs/screenshots/route.webp) | ![Пересадочный узел](docs/screenshots/interchange.webp) |

## Как устроено

**Геометрия решается заранее и на Go — потому что телефону это считать не
надо.** [`go-layout-solver/`](go-layout-solver/) — около 3400 строк, которые
выпрямляют линии до октолинейных углов, сглаживают кольца и разводят
налезающие станции: 304 станции, 16 линий, 386 рёбер. Пороги выведены из
констант самого рендерера
([`separation.go`](go-layout-solver/separation.go)), поэтому оптимизатор считает
в тех же пикселях, в которых рисует канвас. Приложение раскладку не
пересчитывает — оно читает готовые координаты.

**Раскладка подписей — функция штрафа, потому что «читаемо» должно быть
числом.** У наложения подписей, перекрытия станции и пересечения линии свой
явный вес, и соотношение между ними — и есть проектное решение, см.
[`docs/QUALITY.md`](docs/QUALITY.md). Анализатор считает по решённой схеме 25
метрик, а сам код раскладки живёт в двух рантаймах:
[`MetroMapLabelLayout.ts`](src/components/MetroMapLabelLayout.ts) не зависит ни
от DOM, ни от React, измеритель текста инжектится (`ctx.measureText` в браузере,
таблица метрик в Node). Раньше было две копии, обязанные совпадать один в один,
и проверить это было нечем.

**CI проверяет дрейф, а не пороги, — потому что всегда красный сигнал
перестаёт быть сигналом.** Анализатор детерминирован, его отчёт закоммичен,
задача пересчитывает его и падает при расхождении с базовой линией. Осознанная
правка схемы зелёная, как только новый отчёт закоммичен рядом; случайный
регресс — нет.

**Маршруты считаются в воркере по графу в 20 КБ — потому что воркер собирается
отдельным бандлом.** Импорт полного графа продублировал бы в сборке около
123 КБ JSON, поэтому
[`routingGraphPayload.ts`](src/metro/routingGraphPayload.ts) кодирует только
рёбра. Ассет лежит вне `assets/` намеренно: `vite-plugin-pwa` помечает этот
каталог как `revision: null`, и файл с фиксированным именем застрял бы в
прекеше навсегда.

**Обновление ждёт пользователя — потому что офлайн-приложение нельзя подменить
у него под руками.** Ни `skipWaiting`, ни `clientsClaim`: при
`registerType: 'prompt'` новый service worker ждёт подтверждения, ведь
активация под уже загруженной страницей превращает её ленивые чанки в 404. См.
[`docs/service-worker.md`](docs/service-worker.md).

## Стек

**Клиент** — React 19, TypeScript 6, Vite 8 и Canvas 2D; маршрутизация в Web
Worker, PWA и precache через `vite-plugin-pwa`. Интерфейс только на русском.

**Данные и геометрия** — решатель раскладки на Go поверх `data/`, единственного
источника истины: файл на линию плюс `transfers.json` и `layout.json`.
Идентификаторы станций выглядят как `1/park-kultury`.

```
data/  →  go-layout-solver  →  normalized/fullGraph.json  →  приложение
```

**Прод** — статика за системным nginx, релизы через
[deploy-kit](https://github.com/samoy-love/deploy-kit).

## Быстрый старт

```bash
npm install
npm run dev          # дев-сервер
npm run dev:pwa      # дев-сервер с включённым service worker
npm run dev:editor   # редактор схемы (editor.html)
npm run build        # tsc -b && vite build -> dist/
```

Пересборка данных требует Go:

```bash
npm run build:data   # data/ -> normalized/fullGraph.json
npm run quality      # отчёт о качестве раскладки
```

Редактор замыкает круг: станцию можно перетащить, сохранение пишет прямо в
`data/` и заново запускает решатель — перетаскивание в браузере оборачивается
дифом в JSON-файле. Эндпоинт записи живёт в плагине Vite с `apply: 'serve'` и в
сборку не попадает, а сторож отдельно проверяет, что и сам редактор не попал в
прод-бандл.

Полный список команд, что покрывают сквозные тесты и чек-лист перед коммитом —
в [`docs/workflow.md`](docs/workflow.md).

## Структура

| Путь | Назначение |
| --- | --- |
| `data/` | Источник истины по схеме: линии, пересадки, подсказки раскладки |
| `go-layout-solver/` | Решатель на Go: граф, октолинейные углы, форма колец, разведение станций |
| `normalized/` | Производные данные: `fullGraph.json` и закоммиченный `quality_report.json` |
| `src/` | Приложение: React-оболочка, рендер на канвасе, модель метро, маршруты |
| `src/metro/` | Граф, маршрутизация и компактная нагрузка графа для воркера |
| `src/components/` | `MetroMap.tsx` (~4400 строк отрисовки канвасом) и раскладка подписей |
| `scripts/` | Сторожа: редактор не в проде, необъявленные CSS-переменные |
| `scripts/quality/` | Анализатор качества за `npm run quality` |
| `scripts/editor/` | Запись правок редактора обратно в `data/` (только dev-сервер) |
| `e2e/` | Playwright по пути пользователя, включая офлайн |
| `tools/visual-qa/` | Стенд пиксельной приёмки (Docker + Chromium) |
| `public/` | Иконки и favicon |
| `docs/` | Метрики качества, визуальная приёмка, service worker, рабочие сценарии |
| `.deploy-kit/` | Описание цели выкатки |

Манифест PWA и имя service worker генерируются `vite-plugin-pwa` из секции
`manifest` в `vite.config.ts` — отдельного `.webmanifest` в `public/` нет и
заводить его не нужно.

## Тесты

Около 1250 юнит-тестов в 78 файлах (Vitest) плюс 12 сквозных на Playwright и
ещё 2, которые запускаются по проду руками.

```bash
npx tsc -b && npm run lint && npx vitest run
npm run e2e            # сам собирает проект и поднимает preview
npm run e2e:prod       # смоук по https://metro.samoy.love, в CI не висит
bash tools/visual-qa/run.sh   # пиксельная приёмка в Docker
```

Гейт CI: типы, ESLint, сторож CSS-переменных, юниты с покрытием, сборка,
проверка «редактора нет в прод-бандле», сквозной прогон и дрейф отчёта о
качестве. Сквозные тесты падают ещё и на молчании: каждый из них проверяет, что
консоль браузера осталась чистой и ни один запрос не упал, — приложение,
отдающее 200 с мёртвым воркером маршрутов, по коду ответа выглядит живым.
Офлайн проверяется по-настоящему: второй заход идёт с отключённой сетью.
Пиксельная приёмка ([`docs/VISUAL_QA.md`](docs/VISUAL_QA.md)) — локальный шаг в
Docker, а не задача CI: она падает при расхождении больше 0.1% кадра, и
пропавший снимок засчитывается как расхождение.

## Выкатка

```bash
dk deploy metro       # локально, тем же путём, что и CI
dk rollback metro
```

Сборка раскладывается рядом с текущим релизом, симлинк переключается атомарно,
версия сверяется после переключения. Описание цели — `.deploy-kit/prod.env`;
конфигурация nginx и скрипты релиза — в
[deploy-kit](https://github.com/samoy-love/deploy-kit). Выкатка намеренно остаётся
ручным шагом: у установленного PWA релиз доходит до пользователей по правилам
service worker, а не пайплайна.

## Часть samoy.love

`samoy.love` читается как фамилия владельца — Самойлов. Один домен, один
сервер, один релизный пайплайн, одна статус-страница.

| Сервис | Что это | Репозиторий |
| --- | --- | --- |
| [samoy.love](https://samoy.love) | Личная страница и витрина проектов | [samoy-love/samoy.love](https://github.com/samoy-love/samoy.love) |
| [metro.samoy.love](https://metro.samoy.love) | Это приложение | [samoy-love/metro-map](https://github.com/samoy-love/metro-map) |
| [snakes.samoy.love](https://snakes.samoy.love) | Захват территории в браузере | [samoy-love/snakes](https://github.com/samoy-love/snakes) |
| [launcher.samoy.love](https://launcher.samoy.love) | ChillHub, лаунчер игр для Windows | [samoy-love/chillhub](https://github.com/samoy-love/chillhub) |
| [status.samoy.love](https://status.samoy.love) | Аптайм, версии, инциденты | [samoy-love/status.samoy.love](https://github.com/samoy-love/status.samoy.love) |
| Мониторинг | Prometheus, Grafana, посещаемость из логов nginx | [samoy-love/metrics.samoy.love](https://github.com/samoy-love/metrics.samoy.love) |

Все они едут одним инструментом,
[deploy-kit](https://github.com/samoy-love/deploy-kit): одно описание цели в
репозитории, один `release.sh` на сервере, одна конфигурация nginx на всех.

## Контакты и лицензия

Алексей Самойлов — <alex@samoy.love>, [t.me/tr0llex](https://t.me/tr0llex),
[github.com/tr0llex](https://github.com/tr0llex). Задачи —
в [issues](https://github.com/samoy-love/metro-map/issues).

Код — MIT, см. [LICENSE](LICENSE). Названия станций, состав линий и времена
пересадок соответствуют официальной схеме московского метро; геометрия с неё не
скопирована — координаты взяты из публичных референсных данных как затравка,
дальше решены и выправлены здесь. Графическое решение официальной схемы —
работа её авторов: проект его не воспроизводит, а рисует собственную схему по
тем же общеизвестным соглашениям.
