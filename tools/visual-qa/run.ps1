# Визуальная приёмка в одну команду (Windows / Docker Desktop):
#   pwsh -File tools/visual-qa/run.ps1
# Флаги:
#   -SkipBuild        не пересобирать dist (снять скриншоты с текущей сборки)
#   -Only mobile      снять только один профиль (mobile | desktop)
#   -Out <path>       каталог для скриншотов (по умолчанию docs/visual-qa)

param(
  [switch]$SkipBuild,
  [string]$Only = "",
  [string]$Out = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$outDir = if ($Out) { $Out } else { Join-Path $repoRoot "docs\visual-qa" }

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

Write-Host "==> docker build metromap-visual-qa" -ForegroundColor Cyan
docker build -t metromap-visual-qa $PSScriptRoot
if ($LASTEXITCODE -ne 0) { throw "docker build failed" }

Write-Host "==> docker run (скриншоты -> $outDir)" -ForegroundColor Cyan
$envArgs = @()
if ($Only) { $envArgs += @("-e", "QA_ONLY=$Only") }

docker run --rm `
  -v "${distDir}:/app/dist:ro" `
  -v "${outDir}:/out" `
  @envArgs `
  metromap-visual-qa
if ($LASTEXITCODE -ne 0) { throw "docker run failed" }

Write-Host "==> Готово. Скриншоты и report.json: $outDir" -ForegroundColor Green
