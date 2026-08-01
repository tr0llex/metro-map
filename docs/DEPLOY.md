# Деплой

Приложение — статический PWA-бандл. Всё, что нужно раздать, лежит в `dist/` после `npm run build`.

```bash
npm ci
npm run build      # tsc -b && vite build  ->  dist/
```

Отдельная сборка редактора (не публикуется вместе с приложением):

```bash
npm run build:editor   # -> dist-editor/
```

---

## Netlify

Конфигурация в [`netlify.toml`](../netlify.toml): команда `npm run build`, каталог публикации `dist`.
Отдельных редиректов не заведено — SPA-фоллбэк на Netlify по умолчанию не включён,
приложение работает от корня `/`, так что этого достаточно.

---

## Свой сервер (nginx) — основной способ

```bash
npm run deploy          # сборка + конфиг + статика + smoke-тест
npm run deploy:config   # только nginx-конфиг
npm run deploy:app      # только статика
npm run deploy:dry      # ничего не менять, показать план и диффы
```

Скрипт — [`scripts/deploy.sh`](../scripts/deploy.sh), конфиг под версионным
контролем — [`deploy/nginx/metro.conf`](../deploy/nginx/metro.conf).

**На сервере живёт несколько проектов** (`metro.samoy.love`, `launcher.samoy.love`).
Поэтому скрипт устроен так:

* трогает ровно две вещи — `/etc/nginx/sites-available/metro.conf` и `/var/www/metro`;
  соседние конфиги и каталоги не открываются на запись;
* **отказывается работать, если `nginx -t` падает ещё до деплоя** — иначе чужая поломка
  попала бы в наш бэкап и «чинилась» бы нашим откатом;
* перед заменой конфига кладёт бэкап в `/etc/nginx/sites-available/.backups/metro.conf.<дата>`;
* перезагружает nginx **только** после успешного `nginx -t`, а при неудаче автоматически
  возвращает предыдущий конфиг;
* статику выкладывает атомарно: распаковывает рядом, потом переставляет каталоги;
  предыдущая версия остаётся в `/var/www/metro.prev` для быстрого отката;
* после выкладки проверяет главную, service worker, манифест **и что соседний проект жив**.

Быстрый откат статики:

```bash
ssh ubuntu@<host> 'sudo rm -rf /var/www/metro && sudo mv /var/www/metro.prev /var/www/metro'
```

Настройки переопределяются переменными окружения: `METRO_SSH_HOST`, `METRO_SSH_KEY`,
`METRO_DOMAIN`.

> Деплой из GitHub Actions заведён: [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml),
> запуск только вручную (workflow_dispatch) с выбором цели. Чтобы он заработал, владельцу
> репозитория нужно добавить секрет `METRO_SSH_KEY` с приватным SSH-ключом.

### Требования к конфигу

Ниже — та часть, которая относится к этому приложению (полный рабочий конфиг лежит
в `deploy/nginx/metro.conf`). Раньше в репозитории хранился весь `nginx.conf` сервера
вместе с конфигурацией постороннего проекта и путями к TLS-сертификатам — инфраструктуре
не место в репозитории приложения.

Ключевые требования:

1. **Хешированные ассеты** (`/assets/kitty-metro-*-<hash>.js|css|svg|png`) — иммутабельный кэш на год.
2. **Service worker** (`/kitty-metro-sw.js`) и **манифест** (`/kitty-metro-manifest.webmanifest`) —
   никогда не кэшировать надолго, иначе пользователи не получат обновление.
3. **`index.html` и любой HTML** — `no-store`, иначе SPA залипает на старой версии.
4. **SPA-фоллбэк** — любой неизвестный путь отдаёт `index.html`.

Имена файлов SW и манифеста заданы в `vite.config.ts`
(`filename` и `manifestFilename` у `VitePWA`) — если их поменять, поправьте и конфиг сервера.

```nginx
server {
    server_name metro.samoy.love;   # + ваш TLS-блок

    root /var/www/metro;
    index index.html;
    etag on;

    add_header X-Content-Type-Options nosniff;
    add_header X-Frame-Options DENY;

    # SPA-фоллбэк: всё неизвестное отдаём index.html и не кэшируем
    location / {
        try_files $uri /index.html;
        add_header Cache-Control "no-store, no-cache, must-revalidate" always;
        add_header Pragma "no-cache" always;
        add_header Expires "0" always;
    }

    location = /index.html {
        try_files /index.html =404;
        add_header Cache-Control "no-store, no-cache, must-revalidate" always;
    }

    # Ассеты Vite: имена уже содержат хеш
    location ^~ /assets/ {
        try_files $uri =404;
    }

    # PWA-манифест: короткий кэш с ревалидацией
    location = /kitty-metro-manifest.webmanifest {
        try_files /kitty-metro-manifest.webmanifest =404;
        add_header Cache-Control "public, max-age=600, must-revalidate" always;
    }

    # Service worker: всегда ревалидировать
    location = /kitty-metro-sw.js {
        try_files /kitty-metro-sw.js =404;
        add_header Cache-Control "public, max-age=0, must-revalidate" always;
    }

    # Легаси service worker (см. ниже) — тоже всегда ревалидировать
    location = /sw.js {
        try_files /sw.js =404;
        add_header Cache-Control "public, max-age=0, must-revalidate" always;
    }

    # Файлы с хешем в имени — иммутабельно
    location ~* "^/.+[-.][a-f0-9]{8,}\.(?:css|js|mjs|map|png|jpg|jpeg|webp|gif|svg|ico|woff2?|ttf|eot)$" {
        try_files $uri =404;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
    }

    # Остальная статика без хеша — ревалидировать
    location ~* ^/.+\.(?:css|js|mjs|map|png|jpg|jpeg|webp|gif|svg|ico|woff2?|ttf|eot)$ {
        try_files $uri =404;
        add_header Cache-Control "public, max-age=0, must-revalidate" always;
    }

    location ~* ^/.+\.(?:html)$ {
        try_files $uri =404;
        add_header Cache-Control "no-store, no-cache, must-revalidate" always;
    }
}
```

---

## Легаси service worker `public/sw.js`

Исторически приложение регистрировало service worker по адресу `/sw.js`.
Сейчас SW генерируется `vite-plugin-pwa` и называется `/kitty-metro-sw.js`,
но у части пользователей в браузере всё ещё зарегистрирован старый `/sw.js`.

`public/sw.js` — это **не рабочий кэширующий SW, а клинер**: он проксирует все запросы в сеть,
чистит старые кэши и снимает собственную регистрацию. Пока он раздаётся с сервера,
старые установки постепенно самоочищаются.

**Удалять его нельзя до 2027-02-01** (ориентир — полгода после релиза 1.0.0).
После этой даты можно удалить `public/sw.js` и `location = /sw.js` из конфига nginx.
