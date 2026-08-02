# Метро Москвы

[![CI](https://github.com/tr0llex/MetroMap/actions/workflows/ci.yml/badge.svg)](https://github.com/tr0llex/MetroMap/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/tr0llex/MetroMap/branch/main/graph/badge.svg)](https://codecov.io/gh/tr0llex/MetroMap)


Офлайн-PWA для построения маршрутов по московскому метро.
Схема рисуется на Canvas по предрасчитанным координатам, маршрут считается на клиенте —
приложение полностью работает без сети.

Ориентир качества схемы — свойства хорошей схемы метро сами по себе: октолинейная
геометрия, гладкие кольца, слитые пересадочные хабы, читаемые подписи. Схема Яндекса
используется только как источник референсных координат при холодном старте; сходство
с ней **не измеряется** — метрики проверяют однородность и читаемость самой схемы
(коммит `7f51164`, список метрик — `docs/QUALITY.md`).

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
data/lines/*.json    ─┐
data/transfers.json  ─┼─> go-layout-solver ─> normalized/fullGraph.json ─> UI
data/layout.json     ─┘
```

### 3.1. Источник

Всё, что рисуется на схеме и участвует в расчёте маршрута, лежит в `data/` и
правится руками. Подробное описание формата — в [`data/README.md`](data/README.md).

- **`data/lines/*.json`** — по файлу на линию: станции по порядку следования,
  время до следующей станции, геокоординаты, ответвления. Покрытие: метро Москвы,
  МЦК и БКЛ. МЦД (D1–D4) не моделируются.
- **`data/transfers.json`** — пересадки между линиями (пара идентификаторов + тип)
  и все значения времени по умолчанию. Пересадочные узлы здесь не хранятся: узел —
  это связная компонента списка, солвер выводит её сам.
- **`data/layout.json`** — координаты станций на схеме. Расставлены руками,
  правятся редактором.

Прежний вход — дамп `new_map_source/metro.ru.csv` по всем городам России плюс
`connections.json` со ссылками на станции **текстом**, а поверх результата сборки
ещё слой правок `normalized/editor_overrides.json`. Настоящие данные жили в
результате сборки, а не во входе, поэтому править вход было нельзя; сопоставление
по именам молча теряло связь при любом расхождении в написании. Всё это удалено.

### 3.2. Решатель

`go-layout-solver/` (Go) читает `data/` и пишет `normalized/fullGraph.json`.

Проход ровно один и он геометрический: `ApplyRingProjection` (`rings.go`) —
подгонка формы каждого кольца по его станциям, проекция станций на форму,
разведение налезающих станций (`separation.go`) и публикация форм в `ringShapes`
файла `fullGraph.json` (рантайм форму не подбирает, только читает — см.
`docs/QUALITY.md`).

Автоматической раскладки «с нуля» больше нет. Она жила в `layout_bootstrap.go`,
запускалась только при пустых оверрайдах и на реальных данных не выполнялась
никогда: координаты всех станций расставлены руками. Теперь они лежат в
`data/layout.json` как обычные данные, и алгоритм, которому нечего вычислять,
удалён вместе с ветвлением.

Ручные формы колец (`rings` в `data/layout.json`) поддержаны, но по умолчанию
ключ пуст — формы подбираются автоматически, солвер печатает результат подгонки
для каждого кольца.

Вход проверяется при сборке: дубль идентификатора, пересадка на несуществующую
станцию, станция без координат и ещё десяток случаев останавливают сборку с
сообщением. Раньше такие ошибки молча выкидывали станцию из схемы.

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

Что именно проверяется, какие пороги приняты и **что проверяет CI** (не `quality:check`,
а отсутствие дрейфа относительно закоммиченного отчёта) — в
[`docs/QUALITY.md`](docs/QUALITY.md).

**Числовые значения метрик в этом README сознательно не приводятся.** Любая зафиксированная
здесь цифра протухает после первой же пересборки данных — единственный источник правды
это `npm run quality`.

Открытые направления работы по схеме перечислены в [`ROADMAP.md`](ROADMAP.md) —
там же указано, какой метрикой мерить каждое из них.

---

## 6. Где что лежит

```
data/                схема метро: линии, пересадки, раскладка (источник истины)
go-layout-solver/   Go-решатель: строит граф и геометрию колец
normalized/         производные данные: fullGraph.json, quality_report.json
scripts/            deploy.sh (деплой на свой сервер),
                    check-prod-bundle.mjs (сторож: редактор не должен попасть в прод)
scripts/quality/    анализатор качества схемы
src/                приложение (React + Canvas) и модуль метро
public/             иконки, favicon, легаси sw.js
tools/visual-qa/    стенд визуальной приёмки (Docker + Chromium)
deploy/nginx/       боевой конфиг nginx под версионным контролем
docs/               DEPLOY.md, QUALITY.md, VISUAL_QA.md, LICENSING.md, REVIEW_*.md
docs/visual-qa/     зафиксированные скриншоты приёмки
.github/workflows/  CI и ручной деплой
```

Манифест PWA и имя service worker генерируются `vite-plugin-pwa` из секции `manifest`
в `vite.config.ts` — отдельного `.webmanifest` в `public/` нет и заводить его не нужно.

---

## 7. Рабочие сценарии

**Поменялись данные метро** (`data/**`)
или **геометрия колец** (`go-layout-solver/*.go`):

```bash
npm run build:data && npm run quality
```

затем визуальная проверка: центр схемы, три кольца, 5–10 крупных хабов.

**Подвинули станции в редакторе:** скопировать `data/layout.json` кнопкой `OVR`
в `npm run dev:editor`, вставить в файл, затем те же две команды. Правки не по
координатам (название станции, состав линии, время перегона) редактор не
выгружает — их место в `data/lines/*.json` и `data/transfers.json`.

**Перед коммитом:**

```bash
npx tsc -b && npm run lint && npx vitest run && npm run build && npm run check:bundle
```

Тот же набор гоняет CI — `.github/workflows/ci.yml`.

`npm run check:bundle` — сторож, который ищет в `dist/` характерные строки редактора.
Вырезание редактора из прода держится на сворачивании мёртвой ветки Rollup-ом и ломается
молча, поэтому проверяется фактом. Он же вызывается из `scripts/deploy.sh` перед выкладкой.

Если менялась схема, туда же добавляется `npm run quality` с коммитом
обновлённого `normalized/quality_report.json` — CI сверяет отчёт с этой базовой линией.

---

## 8. Деплой

См. [`docs/DEPLOY.md`](docs/DEPLOY.md): сборка, nginx, правила кэширования
для своего nginx (хешированные ассеты, service worker, манифест, SPA-фоллбэк).

---

## 9. Лицензия и бренд

Файла `LICENSE` пока нет. Бренд-блокер снят: имя и айдентика Hello Kitty удалены
(коммит `a94c660`), изображений персонажа в репозитории не осталось. Оставшийся
вопрос — **происхождение данных метро** в `data/`.
Подробности — в [`docs/LICENSING.md`](docs/LICENSING.md).

---

## 10. Планы

Единственный актуальный роадмап — [`ROADMAP.md`](ROADMAP.md).
