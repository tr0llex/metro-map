# Метро Москвы

Офлайн-PWA для построения маршрутов по московскому метро.
Схема рисуется на Canvas по предрасчитанным координатам, маршрут считается на клиенте —
приложение полностью работает без сети.

Ориентир качества схемы — Яндекс.Метро: октолинейная геометрия, выпуклые кольца,
радиалы-хорды, слитые пересадочные хабы.

---

## 1. Стек

- **UI:** React 19 + TypeScript, сборка Vite 7
- **Рендер схемы:** Canvas 2D — `src/components/MetroMap.tsx`
- **PWA:** `vite-plugin-pwa` в режиме `generateSW` (`registerType: 'prompt'`)
- **Маршрутизация:** собственный модуль `src/metro/`, тяжёлые расчёты вынесены в `src/routeWorker.ts`
- **Пайплайн данных:** Go-решатель `go-layout-solver/` + вспомогательные TS-скрипты (запуск через `tsx`)
- **Тесты:** Vitest, линт — ESLint 9 (flat config)

---

## 2. Быстрый старт

```bash
npm install

npm run dev          # дев-сервер
npm run dev:pwa      # дев-сервер с включённым service worker
npm run dev:editor   # редактор схемы (editor.html)

npm run build        # tsc -b && vite build -> dist/
npm run preview      # предпросмотр продакшн-сборки

npm run lint         # ESLint
npm test             # Vitest (watch); в CI — npx vitest run
```

Пересборка данных и проверка качества схемы:

```bash
npm run build:data     # пересобрать normalized/fullGraph.json (нужен Go)
npm run quality        # анализ качества схемы -> normalized/quality_report.json
npm run quality:check  # то же, но с ненулевым кодом выхода при регрессе (для CI)
```

> **Важно:** UI не пересчитывает layout. Он использует готовые `layoutX/layoutY`
> из `normalized/fullGraph.json`. После любых правок Go-решателя обязательно
> запускайте `npm run build:data`, а затем `npm run quality`.

---

## 3. Пайплайн данных

```
new_map_source/metro.ru.csv      ─┐
new_map_source/connections.json  ─┼─> go-layout-solver ─> normalized/fullGraph.json ─> UI
normalized/yandex_coords.json    ─┤
normalized/editor_overrides.json ─┘
```

### 3.1. Источники

- **`new_map_source/metro.ru.csv`** — станции и линии: `cityId`, `cityName`, `lineId`, `lineName`,
  `lineColorHex`, `stationNumericId`, `stationName`, `lat`, `lng`, `order`.
  Покрытие: метро Москвы + МЦК (включая БКЛ). МЦД (D1–D4) исключены.
- **`new_map_source/connections.json`** — пересадки, включая `interchange`, `cross_platform`,
  `mcc`, `out-of-station`.
- **`normalized/yandex_coords.json`** — референсные координаты со схемы Яндекса; получаются
  скриптом `scripts/extract_yandex_coords.ts` (`npm run extract:yandex`) из сохранённого
  `new_map_source/yandex_metro.html`.
- **`normalized/editor_overrides.json`** — ручные правки из редактора схемы
  (координаты станций, подписи, параметры хабов и рёбер).

### 3.2. Решатель

`go-layout-solver/` (Go) читает всё перечисленное и пишет `normalized/fullGraph.json`.
Точная последовательность проходов живёт в коде — `main.go`, `graph.go`, `graph_overrides.go`;
здесь важен только порядок по смыслу:

1. фильтрация данных (только Москва, без МЦД) и проекция `lat/lng` в плоскость;
2. сборка линий, станций, рёбер и пересадочных хабов;
3. геометрия колец (Кольцевая, МЦК, БКЛ), включая канонические формы из оверрайдов;
4. снап станций хаба в одну точку с приоритетом кольцевых линий;
5. раздвижение станций внутри кольца и сглаживание некольцевых линий;
6. октолинейные коридоры и итеративная оптимизация позиций;
7. финальное масштабирование карты.

Параметры оптимизатора — `normalized/best_params.json`.
Ручные канонические позиции и формы колец — `normalized/editor_overrides.json`.

### 3.3. Формат `fullGraph.json`

```ts
interface FullGraphLine { id: number; title: string; colorHex: string; stationIds: string[] }

interface FullGraphStation {
  id: string; title: string
  lineNumericId: number | null
  isTransfer: boolean
  hubId?: string
  layoutX?: number; layoutY?: number
  lat?: number; lon?: number
}

interface FullGraphEdge {
  fromStationId: string; toStationId: string
  lineNumericId?: number
  medianTravelSeconds: number
  isTransfer?: boolean
}

interface FullGraphTransferHub { id: string; stationIds: string[]; minTransferSeconds: number }
```

Актуальные размеры графа (линии / станции / рёбра / хабы) здесь намеренно не продублированы —
они меняются вместе с данными. Смотрите вывод `npm run quality`.

---

## 4. Рантайм (`src/`)

- **`main.tsx`** — bootstrap приложения; **`editor-main.tsx`** — точка входа редактора (`editor.html`).
- **`App.tsx`** — состояние «Откуда/Куда», вызов маршрутизатора, передача подсветки в карту,
  режим редактора.
- **`routeWorker.ts`** — расчёт маршрутов в Web Worker, чтобы не блокировать рендер.
- **`metro/types.ts`** — типы линий, станций, рёбер, хабов и результата маршрута.
- **`metro/fullGraph.ts`** — типизированный импорт `normalized/fullGraph.json`.
- **`metro/graphCore.ts`** — низкоуровневая работа с графом: ключи рёбер, список смежности,
  поиск кратчайшего пути, сборка `RouteResult`.
- **`metro/routing.ts`** — публичный API: `findShortestRouteFullGraph`,
  `findRouteAlternativesFullGraph`; поддерживает оверрайды и дополнительные рёбра редактора.
- **`metro/layoutEngine.ts`** — fallback-layout на случай, если у станций нет `layoutX/layoutY`.
- **`components/MetroMap.tsx`** — Canvas-схема: линии, станции, хабы, коллизионное размещение
  подписей, pan/zoom мышью и тачем, выбор станции по клику, drag & drop в режиме редактора.
- **`components/`** — остальной UI: форма маршрута, шторка деталей, шапка, сплэш,
  баннер обновления PWA, карточка установки, панель редактора хабов.
- **`public/sw.js`** — клинер старых регистраций `/sw.js`; не удалять до срока,
  указанного в `docs/DEPLOY.md`.

---

## 5. Качество схемы

Метрики считает `scripts/quality/analyze.ts`:

```bash
npm run quality         # человекочитаемый отчёт + normalized/quality_report.json
npm run quality:check   # режим CI: ненулевой код выхода при нарушении порогов
```

Что именно проверяется и какие пороги приняты — в [`docs/QUALITY.md`](docs/QUALITY.md).
Сырой дамп геометрических метрик предыдущего поколения лежит в `normalized/layout_metrics.json`.

**Числовые значения метрик в этом README сознательно не приводятся.** Любая зафиксированная
здесь цифра протухает после первой же пересборки данных — единственный источник правды
это `npm run quality`.

Открытые направления работы по схеме перечислены в [`ROADMAP.md`](ROADMAP.md) —
там же указано, какой метрикой мерить каждое из них.

---

## 6. Где что лежит

```
new_map_source/     исходные данные (CSV, connections.json, HTML-схема Яндекса)
go-layout-solver/   Go-решатель: строит граф и layout
normalized/         производные данные: fullGraph.json, quality_report.json, оверрайды, параметры
scripts/            extract_yandex_coords.ts (парсер схемы Яндекса)
scripts/quality/    анализатор качества схемы
src/                приложение (React + Canvas) и модуль метро
public/             иконки, favicon, легаси sw.js
docs/               DEPLOY.md, QUALITY.md, LICENSING.md
.github/workflows/  CI
```

Манифест PWA и имя service worker генерируются `vite-plugin-pwa` из секции `manifest`
в `vite.config.ts` — отдельного `.webmanifest` в `public/` нет и заводить его не нужно.

---

## 7. Рабочие сценарии

**Поменялись данные метро** (`metro.ru.csv` / `connections.json`)
или **алгоритм layout** (`go-layout-solver/*.go`):

```bash
npm run build:data && npm run quality
```

затем визуальная проверка: центр схемы, три кольца, 5–10 крупных хабов.

**Поменялись ручные правки в редакторе:** экспортировать `normalized/editor_overrides.json`
из `npm run dev:editor`, затем те же две команды.

**Перед коммитом:**

```bash
npx tsc -b && npm run lint && npx vitest run && npm run build
```

Тот же набор гоняет CI — `.github/workflows/ci.yml`.

---

## 8. Деплой

См. [`docs/DEPLOY.md`](docs/DEPLOY.md): сборка, конфигурация Netlify, правила кэширования
для своего nginx (хешированные ассеты, service worker, манифест, SPA-фоллбэк).

---

## 9. Лицензия и бренд

Лицензии у проекта пока нет — из-за использования имени и айдентики Hello Kitty
(товарный знак Sanrio). Разбор рисков и вариантов — в [`docs/LICENSING.md`](docs/LICENSING.md).
До решения вопроса с брендом проект не стоит публиковать под открытой лицензией.

---

## 10. Планы

Единственный актуальный роадмап — [`ROADMAP.md`](ROADMAP.md).
