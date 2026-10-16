param(
  [int]$Minutes = 32,
  [int]$IntervalSec = 30,
  [int]$Port = 4567,
  [string]$Out = "reports\endurance-memory.csv"
)

$inv = [System.Globalization.CultureInfo]::InvariantCulture
function Fmt([double]$v) { return [math]::Round($v, 1).ToString($inv) }

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $listener) {
  Write-Host "Не знайдено процес, що слухає порт $Port. Спочатку запустіть API (python run.py)." -ForegroundColor Red
  exit 1
}
$apiPid = $listener.OwningProcess
$apiName = (Get-Process -Id $apiPid).ProcessName
Write-Host "API: процес $apiName (PID $apiPid). Запис у $Out кожні $IntervalSec с протягом $Minutes хв. Зупинити раніше: Ctrl+C"

"time,elapsed_min,api_memory_mb,api_cpu_seconds,postgres_memory_mb,postgres_processes" | Out-File -Encoding ascii $Out
$start = Get-Date
$end = $start.AddMinutes($Minutes)
$samples = @()
while ((Get-Date) -lt $end) {
  $api = Get-Process -Id $apiPid -ErrorAction SilentlyContinue
  if (-not $api) { Write-Host "Процес API завершився!" -ForegroundColor Red; break }
  $pg = @(Get-Process -Name postgres -ErrorAction SilentlyContinue)
  $apiMb = $api.WorkingSet64 / 1MB
  $apiCpu = $api.CPU
  $pgMb = ($pg | Measure-Object -Property WorkingSet64 -Sum).Sum / 1MB
  $elapsed = ((Get-Date) - $start).TotalMinutes
  $t = Get-Date -Format "HH:mm:ss"
  "$t,$(Fmt $elapsed),$(Fmt $apiMb),$(Fmt $apiCpu),$(Fmt $pgMb),$($pg.Count)" | Out-File -Append -Encoding ascii $Out
  $samples += $apiMb
  Write-Host ("{0}  хв {1,5}   API: {2,7} MB  CPU {3,7} c   PostgreSQL: {4,7} MB ({5} процесів)" -f $t, (Fmt $elapsed), (Fmt $apiMb), (Fmt $apiCpu), (Fmt $pgMb), $pg.Count)
  Start-Sleep -Seconds $IntervalSec
}

if ($samples.Count -gt 1) {
  $first = $samples[0]; $last = $samples[-1]
  $max = ($samples | Measure-Object -Maximum).Maximum
  Write-Host ""
  Write-Host ("Пам'ять API: на початку {0} MB, у кінці {1} MB, максимум {2} MB, зміна {3} MB" -f (Fmt $first), (Fmt $last), (Fmt $max), (Fmt ($last - $first))) -ForegroundColor Cyan
  Write-Host "Дані збережено у $Out"
}
