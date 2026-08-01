#!/usr/bin/env bash
#
# Деплой metro.samoy.love на свой сервер (nginx).
#
# ВАЖНО: на сервере живёт НЕСКОЛЬКО проектов. Скрипт трогает ровно две вещи:
#   1. /etc/nginx/sites-available/metro.conf  (+ симлинк в sites-enabled)
#   2. /var/www/metro                          (статика приложения)
# Ничего другого — включая chillhub-launcher.conf и /var/www/launcher — не читается
# на запись и не перезаписывается. Конфиг соседей нельзя ломать даже временно,
# поэтому nginx перезагружается ТОЛЬКО после успешного `nginx -t`, а при неудаче
# автоматически восстанавливается предыдущая версия конфига.
#
# Использование:
#   ./scripts/deploy.sh              # конфиг + приложение
#   ./scripts/deploy.sh --config     # только nginx-конфиг
#   ./scripts/deploy.sh --app        # только статику
#   ./scripts/deploy.sh --dry-run    # ничего не менять, только показать план и диффы
#
# Переменные окружения (есть разумные значения по умолчанию):
#   METRO_SSH_HOST  ubuntu@207.127.93.34
#   METRO_SSH_KEY   ~/.ssh/oracle-2025-09-21.key
#   METRO_DOMAIN    metro.samoy.love

set -euo pipefail

SSH_HOST="${METRO_SSH_HOST:-ubuntu@207.127.93.34}"
SSH_KEY="${METRO_SSH_KEY:-$HOME/.ssh/oracle-2025-09-21.key}"
DOMAIN="${METRO_DOMAIN:-metro.samoy.love}"

SITE_NAME="metro.conf"
REMOTE_SITE="/etc/nginx/sites-available/${SITE_NAME}"
REMOTE_LINK="/etc/nginx/sites-enabled/${SITE_NAME}"
REMOTE_BACKUPS="/etc/nginx/sites-available/.backups"
WEB_ROOT="/var/www/metro"

LOCAL_CONF="deploy/nginx/${SITE_NAME}"
LOCAL_DIST="dist"

DO_CONFIG=1
DO_APP=1
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --config)  DO_APP=0 ;;
    --app)     DO_CONFIG=0 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "Неизвестный аргумент: $arg" >&2; exit 2 ;;
  esac
done

STAMP="$(date +%Y%m%d-%H%M%S)"
SSH=(ssh -i "$SSH_KEY" -o ConnectTimeout=20 -o StrictHostKeyChecking=accept-new "$SSH_HOST")

say()  { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- preflight ---
say "Проверки перед деплоем"

[[ -f "$SSH_KEY" ]] || die "нет ключа $SSH_KEY"
[[ -f "$LOCAL_CONF" ]] || die "нет $LOCAL_CONF"

"${SSH[@]}" true 2>/dev/null || die "не удалось подключиться к $SSH_HOST"
ok "SSH до $SSH_HOST"

# Если конфигурация nginx СЛОМАНА ЕЩЁ ДО нас — останавливаемся. Иначе рискуем
# получить чужую поломку в наш откат и «починить» её нашим бэкапом.
"${SSH[@]}" 'sudo nginx -t' >/dev/null 2>&1 \
  || die "nginx -t на сервере падает ДО деплоя — разберитесь с этим раньше, чем катить"
ok "nginx -t проходит до деплоя (базовое состояние здоровое)"

if [[ $DO_APP -eq 1 ]]; then
  [[ -d "$LOCAL_DIST" && -f "$LOCAL_DIST/index.html" ]] \
    || die "нет собранного $LOCAL_DIST — выполните: npm run build"
  # Редактор схемы не должен уезжать в прод (см. scripts/check-prod-bundle.mjs).
  node scripts/check-prod-bundle.mjs >/dev/null || die "редактор попал в прод-бандл, деплой отменён"
  ok "прод-бандл собран и не содержит редактора"
fi

if [[ $DRY_RUN -eq 1 ]]; then
  say "DRY RUN — ниже только план, ничего не меняется"
fi

# ------------------------------------------------------------------- config ---
if [[ $DO_CONFIG -eq 1 ]]; then
  say "nginx-конфиг ($SITE_NAME)"

  REMOTE_NOW="$("${SSH[@]}" "sudo cat $REMOTE_SITE 2>/dev/null || true")"
  if [[ "$REMOTE_NOW" == "$(cat "$LOCAL_CONF")" ]]; then
    ok "на сервере уже актуальная версия, менять нечего"
  else
    printf '  различия (сервер → репозиторий):\n'
    diff <(printf '%s' "$REMOTE_NOW") "$LOCAL_CONF" | sed 's/^/    /' || true

    if [[ $DRY_RUN -eq 0 ]]; then
      # Заливаем во временный файл, бэкапим текущий, ставим новый, проверяем.
      "${SSH[@]}" "cat > /tmp/${SITE_NAME}.new" < "$LOCAL_CONF"
      "${SSH[@]}" "
        set -e
        sudo mkdir -p '$REMOTE_BACKUPS'
        if [ -f '$REMOTE_SITE' ]; then
          sudo cp -a '$REMOTE_SITE' '$REMOTE_BACKUPS/${SITE_NAME}.$STAMP'
        fi
        sudo install -o root -g root -m 0644 /tmp/${SITE_NAME}.new '$REMOTE_SITE'
        rm -f /tmp/${SITE_NAME}.new
        sudo ln -sfn '$REMOTE_SITE' '$REMOTE_LINK'

        if ! sudo nginx -t; then
          echo 'nginx -t упал — откатываю конфиг' >&2
          if [ -f '$REMOTE_BACKUPS/${SITE_NAME}.$STAMP' ]; then
            sudo cp -a '$REMOTE_BACKUPS/${SITE_NAME}.$STAMP' '$REMOTE_SITE'
          else
            sudo rm -f '$REMOTE_SITE' '$REMOTE_LINK'
          fi
          sudo nginx -t
          exit 1
        fi
      " || die "конфиг не прошёл проверку, изменения откачены"
      ok "конфиг установлен, бэкап: $REMOTE_BACKUPS/${SITE_NAME}.$STAMP"
    fi
  fi
fi

# ---------------------------------------------------------------------- app ---
if [[ $DO_APP -eq 1 ]] && [[ $DRY_RUN -eq 0 ]]; then
  say "Статика приложения → $WEB_ROOT"

  # Атомарная замена: распаковываем рядом, потом переставляем каталоги.
  # Предыдущая версия остаётся в ${WEB_ROOT}.prev — на случай быстрого отката.
  tar -czf - -C "$LOCAL_DIST" . | "${SSH[@]}" "cat > /tmp/metro-dist.tgz"
  "${SSH[@]}" "
    set -e
    sudo rm -rf '${WEB_ROOT}.staging'
    sudo mkdir -p '${WEB_ROOT}.staging'
    sudo tar -xzf /tmp/metro-dist.tgz -C '${WEB_ROOT}.staging'
    rm -f /tmp/metro-dist.tgz
    sudo chown -R root:root '${WEB_ROOT}.staging'
    sudo find '${WEB_ROOT}.staging' -type d -exec chmod 755 {} +
    sudo find '${WEB_ROOT}.staging' -type f -exec chmod 644 {} +
    test -f '${WEB_ROOT}.staging/index.html'

    sudo rm -rf '${WEB_ROOT}.prev'
    if [ -d '$WEB_ROOT' ]; then sudo mv '$WEB_ROOT' '${WEB_ROOT}.prev'; fi
    sudo mv '${WEB_ROOT}.staging' '$WEB_ROOT'
  " || die "выкладка статики не удалась"
  ok "статика выложена (предыдущая версия: ${WEB_ROOT}.prev)"
fi

# ------------------------------------------------------------------- reload ---
if [[ $DRY_RUN -eq 0 ]]; then
  say "Перезагрузка nginx"
  "${SSH[@]}" 'sudo nginx -t && sudo systemctl reload nginx' >/dev/null \
    || die "reload не удался"
  ok "nginx перезагружен"

  say "Smoke-тест https://$DOMAIN"
  code="$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/")"
  [[ "$code" == "200" ]] || die "главная отдала $code"
  ok "главная: 200"

  sw="$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/kitty-metro-sw.js")"
  [[ "$sw" == "200" ]] || warn "service worker отдал $sw (ожидалось 200)"
  [[ "$sw" == "200" ]] && ok "service worker: 200"

  mf="$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/kitty-metro-manifest.webmanifest")"
  [[ "$mf" == "200" ]] && ok "манифест: 200" || warn "манифест отдал $mf"

  # Соседний проект обязан продолжать работать.
  nb="$(curl -s -o /dev/null -w '%{http_code}' "https://launcher.samoy.love/" || echo 000)"
  if [[ "$nb" == "200" || "$nb" == "301" || "$nb" == "302" ]]; then
    ok "соседний проект launcher.samoy.love жив ($nb)"
  else
    warn "соседний проект ответил $nb — проверьте вручную"
  fi
fi

say "Готово"
