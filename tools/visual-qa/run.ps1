# Визуальная приёмка в одну команду (Windows / Docker Desktop):
#   pwsh -File tools/visual-qa/run.ps1
#
# Скриншоты по умолчанию НЕ пишутся в репозиторий: прогон — это диагностика,
# а не документ. Каталог по умолчанию — .visual-qa\ в корне (в .gitignore).
# Чтобы зафиксировать новый набор в документации — осознанно: -Publish.
#
# Флаги:
#   -SkipBuild        не пересобирать dist (снять скриншоты с текущей сборки)
#   -Only mobile      снять только один профиль (mobile | desktop)
#   -NoProbes         пропустить диагностические пробники (13–20)
#   -Publish          скопировать результат в docs\visual-qa
#   -Out <path>       каталог для скриншотов (по умолчанию .visual-qa)

param(
  [switch]$SkipBuild,
  [switch]$NoProbes,
  [switch]$Publish,
  [string]$Only = "",
  [string]$Out = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$outDir = if ($Out) { $Out } else { Join-Path $repoRoot ".visual-qa" }

if (-not $SkipBuild) {
  Write-Host "==> npm run build" -ForegroundColor Cyan
  Push-Location $repoRoot
  try { npm run build } finally { Pop-Location }
}

$distDir = Join-Path $repoRoot "dist"
if (-not (Test-Path (Join-Path $distDir "index.html"))) {
  throw "Не найден $distDir\index.html — сначала соберите приложение (npm run build)."
}

New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$outDir = (Resolve-Path $outDir).Path

Write-Host "==> docker build metromap-visual-qa" -ForegroundColor Cyan
docker build -t metromap-visual-qa $PSScriptRoot
if ($LASTEXITCODE -ne 0) { throw "docker build failed" }

$envArgs = @()
if ($Only) { $envArgs += @("-e", "QA_ONLY=$Only") }

function Invoke-Qa([string]$script, [string]$what) {
  Write-Host "==> $script — $what (-> $outDir)" -ForegroundColor Cyan
  docker run --rm `
    -v "${distDir}:/app/dist:ro" `
    -v "${outDir}:/out" `
    @envArgs `
    metromap-visual-qa node $script
  if ($LASTEXITCODE -ne 0) { throw "docker run $script failed" }
}

Invoke-Qa "shoot.mjs" "основные сценарии 01-12"

if (-not $NoProbes) {
  Invoke-Qa "probe.mjs" "прокрутка деталей, дальний переход, узел (13-17)"
  Invoke-Qa "probe-touch.mjs" "реальный тач-свайп по шторке (18-19)"
  Invoke-Qa "probe-zoomout.mjs" "схема целиком на минимальном зуме (20)"
}

if ($Publish) {
  $docsDir = Join-Path $repoRoot "docs\visual-qa"
  Write-Host "==> публикация в $docsDir" -ForegroundColor Cyan
  New-Item -ItemType Directory -Force -Path $docsDir | Out-Null
  Copy-Item -Force (Join-Path $outDir "*.png") $docsDir
  Copy-Item -Force (Join-Path $outDir "*.json") $docsDir
  Write-Host "    скопировано; проверьте git status и закоммитьте осознанно"
}

Write-Host "==> Готово. Скриншоты и report.json: $outDir" -ForegroundColor Green
