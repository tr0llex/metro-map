# Кадры для README

Снимки лежат в `.webp` и вставлены в `README.md` и `README.ru.md` в корне.

| Файл | Что на кадре | Источник |
|---|---|---|
| `overview.webp` | вся схема целиком | `docs/visual-qa/desktop-04-map-full.png` |
| `route.webp` | построенный маршрут с деталями | `docs/visual-qa/desktop-08-route-built.png` |
| `interchange.webp` | слитые пересадочные узлы крупным планом | `docs/visual-qa/desktop-06-map-zoom-center-deep.png` |

## Как обновить

Снимки делает Playwright-харнесс в Docker:

```bash
bash tools/visual-qa/run.sh
```

Полноразмерный кадр — 1440×900 и около 700 КБ; для README его пережимают до
ширины 1200 в WebP. Вес репозитория и так 104 МБ, из них около 30 МБ — снимки
приёмки, поэтому полноразмерные кадры сюда не кладут.

```bash
ffmpeg -i docs/visual-qa/<кадр>.png \
  -vf "scale=1200:-1:flags=lanczos" \
  -c:v libwebp -quality 96 -compression_level 6 \
  docs/screenshots/<имя>.webp
```

WebP выбран из-за веса: PNG той же ширины весит 600 КБ, PNG с палитрой в 256
цветов — 285 КБ и портит мягкие градиенты фона. WebP при quality 96 даёт
87–101 КБ без видимых потерь на подписях станций. GitHub его показывает.
