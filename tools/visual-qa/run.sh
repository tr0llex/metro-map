#!/usr/bin/env bash
# Визуальная приёмка в одну команду (Linux / macOS / Git Bash):
#   bash tools/visual-qa/run.sh
# Переменные окружения:
#   SKIP_BUILD=1   не пересобирать dist
#   QA_ONLY=mobile снять только один профиль (mobile | desktop)
#   OUT_DIR=...    каталог для скриншотов (по умолчанию docs/visual-qa)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/docs/visual-qa}"

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
DOCKER_ENV=()
DIST_MOUNT="$REPO_ROOT/dist"
OUT_MOUNT="$OUT_DIR"
if [ -n "${MSYSTEM:-}" ] || [[ "$(uname -s 2>/dev/null)" == MINGW* ]]; then
  export MSYS_NO_PATHCONV=1
  DIST_MOUNT="$(cd "$REPO_ROOT/dist" && pwd -W 2>/dev/null || echo "$DIST_MOUNT")"
  OUT_MOUNT="$(cd "$OUT_DIR" && pwd -W 2>/dev/null || echo "$OUT_MOUNT")"
fi

echo "==> docker run (скриншоты -> $OUT_DIR)"
docker run --rm \
  -v "${DIST_MOUNT}:/app/dist:ro" \
  -v "${OUT_MOUNT}:/out" \
  ${QA_ONLY:+-e QA_ONLY="$QA_ONLY"} \
  "${DOCKER_ENV[@]+"${DOCKER_ENV[@]}"}" \
  metromap-visual-qa

echo "==> Готово. Скриншоты и report.json: $OUT_DIR"
