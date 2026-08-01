# Стенд визуальной приёмки: настоящий Chromium из официального образа Playwright.
# Внутри контейнера поднимается статик-сервер над примонтированным ./dist,
# поэтому наружу (host.docker.internal) ходить не нужно — всё замкнуто в контейнере.
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

WORKDIR /qa

# Отдельный слой с зависимостями — пересобирается только при смене package.json.
COPY package.json ./
RUN npm install --omit=dev

COPY shoot.mjs ./

# /app/dist — примонтированная сборка приложения, /out — каталог для скриншотов и отчёта.
ENV QA_APP_DIR=/app/dist \
    QA_OUT_DIR=/out \
    QA_PORT=4173

CMD ["node", "shoot.mjs"]
