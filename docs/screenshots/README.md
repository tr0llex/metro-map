# Кадры для README

Плейсхолдеры. Заменить настоящими снимками:

| Файл | Что на кадре | Откуда взять |
|---|---|---|
| `overview.svg` | вся схема на малом зуме | `docs/visual-qa/desktop-20-zoomed-out.png` |
| `route.svg` | построенный маршрут с деталями | `docs/visual-qa/desktop-08-route-built.png` |
| `interchange.svg` | слитый узел крупным планом | `docs/visual-qa/desktop-17-hub-biblioteka.png` |

Снимки делает Playwright-харнесс в Docker:

```bash
bash tools/visual-qa/run.sh
```

Полноразмерные кадры весят по 700 КБ — для README их нужно пережать примерно
до 1200px по ширине, иначе страница грузится секундами. Вес репозитория и так
104 МБ, из них около 30 МБ — снимки приёмки.
