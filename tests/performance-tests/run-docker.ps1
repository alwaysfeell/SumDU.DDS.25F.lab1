param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('smoke', 'load', 'stress', 'spike', 'endurance')]
  [string]$Test,
  [int]$IntervalSec = 5,
  [string]$ReportDir = 'reports\docker',
  [string]$StressLevels = '200,500,1000,1500,2000,3000,4000',
  [int]$SpikeVus = 2000,
  [int]$ApiPort = 4567,
  [switch]$NoRestart
)

$ErrorActionPreference = 'Continue'
$inv = [System.Globalization.CultureInfo]::InvariantCulture
$containers = @('traveler_web', 'traveler_db')

function Say([string]$text, [string]$color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Fail([string]$text) { Write-Host $text -ForegroundColor Red; exit 1 }
function Fmt([double]$v, [int]$digits = 1) { return [math]::Round($v, $digits).ToString($inv) }

$testFile = "tests\$Test-test.js"
if (-not (Test-Path $testFile)) {
  Fail "Не знайдено $testFile. Запускайте скрипт з папки tests\performance-tests."
}
if (-not (Get-Command k6 -ErrorAction SilentlyContinue)) { Fail 'Команду k6 не знайдено. Встановіть k6 (лаб. 2, крок A2).' }
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Fail 'Команду docker не знайдено. Встановіть і запустіть Docker Desktop.' }

docker info --format '{{.ServerVersion}}' 1>$null 2>$null
if ($LASTEXITCODE -ne 0) { Fail 'Docker не відповідає. Запустіть Docker Desktop і дочекайтесь напису "Engine running".' }

foreach ($c in $containers) {
  $state = (docker inspect -f '{{.State.Status}}' $c 2>$null)
  if ($LASTEXITCODE -ne 0 -or $state -ne 'running') {
    Fail "Контейнер $c не запущено. У корені проєкту виконайте: docker compose up -d --build"
  }
}

New-Item -ItemType Directory -Force -Path $ReportDir | Out-Null
$reportAbs = (Resolve-Path $ReportDir).Path

function Wait-Health([int]$timeoutSec) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:$ApiPort/health" -UseBasicParsing -TimeoutSec 3
      if ($r.StatusCode -eq 200) { return $true }
    } catch { }
    Start-Sleep -Seconds 1
  }
  return $false
}

if (-not $NoRestart) {
  Say 'Перезапуск контейнера traveler_web (однаковий стартовий стан для кожного тесту)...'
  docker restart traveler_web | Out-Null
}
if (-not (Wait-Health 90)) {
  Fail "API не відповідає на http://127.0.0.1:$ApiPort/health. Перегляньте логи: docker compose logs web"
}
Say 'API працює: /health -> 200' 'Green'

$statsCsv = Join-Path $reportAbs "$Test-test-docker-stats.csv"
'time,elapsed_s,container,cpu_percent,mem_usage_mb,mem_limit_mb,mem_percent,net_io,block_io,pids' |
  Set-Content -Encoding ascii -Path $statsCsv

$collector = {
  param($csv, $interval, $names)
  $inv = [System.Globalization.CultureInfo]::InvariantCulture
  function ToMb([string]$s) {
    $s = $s.Trim()
    if ($s -notmatch '^([\d\.]+)\s*([A-Za-z]*)$') { return 0 }
    $v = [double]::Parse($Matches[1], $inv)
    switch ($Matches[2]) {
      'B'   { return $v / 1MB }
      'KiB' { return $v / 1KB }  'kB' { return $v * 1000 / 1MB }  'KB' { return $v * 1000 / 1MB }
      'MiB' { return $v }        'MB' { return $v * 1000 * 1000 / 1MB }
      'GiB' { return $v * 1024 } 'GB' { return $v * 1e9 / 1MB }
      default { return $v }
    }
  }
  $start = Get-Date
  while ($true) {
    $tick = Get-Date
    $rows = docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.NetIO}}|{{.BlockIO}}|{{.PIDs}}' $names 2>$null
    $elapsed = [math]::Round(((Get-Date) - $start).TotalSeconds).ToString($inv)
    $time = Get-Date -Format 'HH:mm:ss'
    foreach ($row in $rows) {
      $f = $row -split '\|'
      if ($f.Count -lt 7) { continue }
      $cpu = $f[1].Trim().TrimEnd('%'); if ($cpu -eq '' -or $cpu -eq '--') { $cpu = '0' }
      $mem = $f[2] -split '/'
      $used = [math]::Round((ToMb $mem[0]), 1).ToString($inv)
      $limit = [math]::Round((ToMb $mem[1]), 1).ToString($inv)
      $memPct = $f[3].Trim().TrimEnd('%')
      $line = '{0},{1},{2},{3},{4},{5},{6},{7},{8},{9}' -f $time, $elapsed, $f[0].Trim(), $cpu, $used, $limit, $memPct, $f[4].Trim(), $f[5].Trim(), $f[6].Trim()
      Add-Content -Encoding ascii -Path $csv -Value $line
    }
    $left = $interval - ((Get-Date) - $tick).TotalSeconds
    if ($left -gt 0) { Start-Sleep -Milliseconds ([int]($left * 1000)) }
  }
}

$job = Start-Job -ScriptBlock $collector -ArgumentList $statsCsv, $IntervalSec, $containers
Say "docker stats: запис кожні $IntervalSec с у $ReportDir\$Test-test-docker-stats.csv"

$reportForK6 = $ReportDir -replace '\\', '/'
$k6args = @('run', '-e', "REPORT_DIR=$reportForK6")
if ($Test -eq 'smoke') {
  $env:K6_WEB_DASHBOARD = 'false'
  $k6args += @('--summary-export', "$ReportDir\smoke-test-summary.json")
} else {
  $env:K6_WEB_DASHBOARD = 'true'
  $env:K6_WEB_DASHBOARD_OPEN = 'true'
  $env:K6_WEB_DASHBOARD_EXPORT = "$ReportDir\$Test-test-dashboard.html"
}
if ($Test -eq 'stress') { $k6args += @('-e', "STRESS_LEVELS=$StressLevels") }
if ($Test -eq 'spike') { $k6args += @('-e', "SPIKE_VUS=$SpikeVus") }
$k6args += $testFile

Say ''
Say ("k6 " + ($k6args -join ' ')) 'Cyan'
$startedAt = Get-Date
$k6exit = 0
try {
  & k6 @k6args
  $k6exit = $LASTEXITCODE
} finally {
  Start-Sleep -Seconds ([math]::Min(2 * $IntervalSec, 15))
  Stop-Job $job -ErrorAction SilentlyContinue | Out-Null
  Remove-Job $job -Force -ErrorAction SilentlyContinue | Out-Null
  $env:K6_WEB_DASHBOARD = $null
  $env:K6_WEB_DASHBOARD_OPEN = $null
  $env:K6_WEB_DASHBOARD_EXPORT = $null
}
$finishedAt = Get-Date

$data = @(Import-Csv -Path $statsCsv)
$out = New-Object System.Collections.Generic.List[string]
$out.Add('=' * 100)
$out.Add("DOCKER STATS — $Test-test   ($($startedAt.ToString('yyyy-MM-dd HH:mm:ss')) – $($finishedAt.ToString('HH:mm:ss')), k6 exit code $k6exit)")
$out.Add('=' * 100)
$engine = (docker info --format '{{.ServerVersion}}|{{.OperatingSystem}}|{{.NCPU}}|{{.MemTotal}}' 2>$null)
if ($engine) {
  $e = $engine -split '\|'
  $out.Add(("Середовище: Docker {0}, {1}, доступно Docker: {2} CPU, {3} GB RAM" -f $e[0], $e[1], $e[2], (Fmt ([double]$e[3] / 1GB))))
}
$out.Add("Заміри: кожні $IntervalSec с, файл $ReportDir\$Test-test-docker-stats.csv")
$out.Add('CPU % — як у docker stats: 100% = одне повне ядро.')
$out.Add('')
$out.Add(('{0,-14} {1,8} {2,10} {3,10} {4,12} {5,12} {6,12} {7,12} {8,8}' -f 'Контейнер', 'Замірів', 'CPU avg', 'CPU max', 'RAM старт', 'RAM кінець', 'RAM max', 'Ліміт RAM', 'PIDs max'))
$out.Add('-' * 100)
foreach ($c in $containers) {
  $rows = @($data | Where-Object { $_.container -eq $c })
  if ($rows.Count -eq 0) { $out.Add(('{0,-14} немає даних' -f $c)); continue }
  $cpu = @($rows | ForEach-Object { [double]::Parse($_.cpu_percent, $inv) })
  $mem = @($rows | ForEach-Object { [double]::Parse($_.mem_usage_mb, $inv) })
  $pids = @($rows | ForEach-Object { [int]$_.pids })
  $cpuAvg = ($cpu | Measure-Object -Average).Average
  $cpuMax = ($cpu | Measure-Object -Maximum).Maximum
  $memMax = ($mem | Measure-Object -Maximum).Maximum
  $pidMax = ($pids | Measure-Object -Maximum).Maximum
  $limit = [double]::Parse($rows[0].mem_limit_mb, $inv)
  $out.Add(('{0,-14} {1,8} {2,10} {3,10} {4,12} {5,12} {6,12} {7,12} {8,8}' -f $c, $rows.Count,
      ((Fmt $cpuAvg) + '%'), ((Fmt $cpuMax) + '%'), ((Fmt $mem[0]) + ' MB'), ((Fmt $mem[-1]) + ' MB'),
      ((Fmt $memMax) + ' MB'), ((Fmt $limit 0) + ' MB'), $pidMax))
}
$out.Add('')
if ($Test -eq 'smoke') { $out.Add("Підсумок k6: $ReportDir\smoke-test-summary.json") }
else { $out.Add("Підсумок k6: $ReportDir\$Test-test-summary.txt, графіки: $ReportDir\$Test-test-dashboard.html") }
$out.Add('=' * 100)

$summaryFile = Join-Path $reportAbs "$Test-test-docker-stats-summary.txt"
$out | Set-Content -Encoding UTF8 -Path $summaryFile
Say ''
$out | ForEach-Object { Write-Host $_ -ForegroundColor Cyan }
Say "Збережено: $ReportDir\$Test-test-docker-stats-summary.txt" 'Green'
