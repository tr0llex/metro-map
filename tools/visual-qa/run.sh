#!/usr/bin/env bash
# Визуальная приёмка в одну команду (Linux / macOS / Git Bash):
#   bash tools/visual-qa/run.sh
#
# Скриншоты по умолчанию НЕ пишутся в репозиторий: прогон — это диагностика,
# а не документ. Каталог по умолчанию — .visual-qa/ в корне (в .gitignore).
# Раньше умолчанием был docs/visual-qa, и штатный прогон оставлял два десятка
# изменённых PNG в рабочем дереве. Чтобы зафиксировать новый набор в
# документации — осознанно: QA_PUBLISH=1 (или сравните и скопируйте руками).
#
# Переменные окружения:
#   SKIP_BUILD=1   не пересобирать dist
#   QA_ONLY=mobile снять только один профиль (mobile | desktop)
#   QA_PROBES=0    пропустить диагностические пробники (13–20)
#   QA_PUBLISH=1   скопировать результат в docs/visual-qa (зафиксировать отчёт)
#   OUT_DIR=...    каталог для скриншотов (по умолчанию .visual-qa)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/.visual-qa}"

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "==> npm run build"
  (cd "$REPO_ROOT" && npm run build)
fi

if [ ! -f "$REPO_ROOT/dist/index.html" ]; then
  echo "Не найден dist/index.html — сначала соберите приложение (npm run build)." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

echo "==> docker build metromap-visual-qa"
docker build -t metromap-visual-qa "$HERE"

# Git Bash (MSYS) переписывает пути внутри аргументов docker: `-v /c/repo/dist:/app/dist:ro`
# превращается в мусор вида `C:/repo/dist;C:/app/dist`, docker молча создаёт пустой
# каталог с суффиксом `;C`, монтирования не происходит, и стенд снимает пустую страницу.
# Лечится отключением конвертации плюс путями в виде, понятном Docker Desktop.
DIST_MOUNT="$REPO_ROOT/dist"
OUT_MOUNT="$OUT_DIR"
if [ -n "${MSYSTEM:-}" ] || [[ "$(uname -s 2>/dev/null)" == MINGW* ]]; then
  export MSYS_NO_PATHCONV=1
  DIST_MOUNT="$(cd "$REPO_ROOT/dist" && pwd -W 2>/dev/null || echo "$DIST_MOUNT")"
  OUT_MOUNT="$(cd "$OUT_DIR" && pwd -W 2>/dev/null || echo "$OUT_MOUNT")"
fi

qa_run() { # имя сценария → node <файл> в контейнере
  docker run --rm \
    -v "${DIST_MOUNT}:/app/dist:ro" \
    -v "${OUT_MOUNT}:/out" \
    ${QA_ONLY:+-e QA_ONLY="$QA_ONLY"} \
    metromap-visual-qa node "$1"
}

echo "==> shoot.mjs — основные сценарии 01–12 (скриншоты -> $OUT_DIR)"
qa_run shoot.mjs

if [ "${QA_PROBES:-1}" != "0" ]; then
  echo "==> probe.mjs — прокрутка деталей, дальний переход, узел (13–17)"
  qa_run probe.mjs
  echo "==> probe-touch.mjs — реальный тач-свайп по шторке (18–19)"
  qa_run probe-touch.mjs
  echo "==> probe-zoomout.mjs — схема целиком на минимальном зуме (20)"
  qa_run probe-zoomout.mjs
fi

if [ "${QA_PUBLISH:-0}" = "1" ]; then
  echo "==> публикация в docs/visual-qa"
  mkdir -p "$REPO_ROOT/docs/visual-qa"
  cp -f "$OUT_DIR"/*.png "$OUT_DIR"/*.json "$REPO_ROOT/docs/visual-qa/"
  echo "    скопировано; проверьте git status и закоммитьте осознанно"
fi

echo "==> Готово. Скриншоты и report.json: $OUT_DIR"
