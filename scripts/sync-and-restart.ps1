param(
  [Parameter(Mandatory = $true)]
  [string]$DshRoot,

  [Parameter(Mandatory = $true)]
  [string]$DshHome,

  [Parameter(Mandatory = $true)]
  [string]$HealthUrl,

  [Parameter(Mandatory = $true)]
  [string]$NodeExecutable,

  [Parameter(Mandatory = $true)]
  [int]$DshProcessId,

  [ValidateRange(0, 30)]
  [int]$DelaySeconds = 2
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$dshRootPath = [System.IO.Path]::GetFullPath($DshRoot)
$dshHomePath = [System.IO.Path]::GetFullPath($DshHome)
$nodePath = [System.IO.Path]::GetFullPath($NodeExecutable)
$startScript = Join-Path $dshRootPath 'Start-Official-DSH.ps1'
$pluginRoot = Split-Path -Parent $PSScriptRoot
$syncScript = Join-Path $pluginRoot 'sync\sync.mjs'
$logRoot = Join-Path $dshHomePath 'codex-oneway-sync\plugin-runs'
$logPath = Join-Path $logRoot ("sync-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))

New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
Start-Transcript -Path $logPath -Append | Out-Null

$mutex = New-Object System.Threading.Mutex($false, 'Local\DshCodexSessionSync')
$mutexAcquired = $false

try {
  try {
    $mutexAcquired = $mutex.WaitOne(0)
  } catch [System.Threading.AbandonedMutexException] {
    $mutexAcquired = $true
  }

  if (-not $mutexAcquired) {
    throw 'Another Codex session synchronization is already running.'
  }
  foreach ($required in @($nodePath, $startScript, $syncScript)) {
    if (-not (Test-Path -LiteralPath $required)) {
      throw "Cannot find required official DSH resource: $required"
    }
  }

  if ($DelaySeconds -gt 0) {
    Start-Sleep -Seconds $DelaySeconds
  }

  $dshProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $DshProcessId" -ErrorAction SilentlyContinue
  if (-not $dshProcess -or $dshProcess.CommandLine -notlike "*$dshRootPath*") {
    throw "PID $DshProcessId is not the configured official DSH process."
  }

  Write-Host 'Stopping official DSH to avoid concurrent session writes...'
  Stop-Process -Id $DshProcessId -Force
  Start-Sleep -Milliseconds 500

  $syncExitCode = 1
  $syncError = $null
  $restartError = $null
  try {
    Write-Host 'Syncing new and updated Codex sessions into the official DSH home...'
    $env:NODE_NO_WARNINGS = '1'
    & $nodePath $syncScript --apply --quiet --prune-redundant-branches --dsh-home $dshHomePath
    $syncExitCode = $LASTEXITCODE
  } catch {
    $syncError = $_
  } finally {
    Write-Host 'Restarting official DSH...'
    try {
      & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $startScript -NoOpen
      if ($LASTEXITCODE -ne 0) {
        throw "Official DSH launcher exited with code $LASTEXITCODE."
      }
      $deadline = [DateTime]::UtcNow.AddSeconds(60)
      $healthy = $false
      while ([DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 500
        try {
          $response = Invoke-WebRequest -UseBasicParsing -Uri $HealthUrl -TimeoutSec 2
          if ($response.StatusCode -eq 200) {
            $healthy = $true
            break
          }
        } catch { }
      }
      if (-not $healthy) {
        throw "Official DSH did not become healthy at $HealthUrl within 60 seconds."
      }
    } catch {
      $restartError = $_
    }
  }

  if ($null -ne $syncError) { throw $syncError }
  if ($syncExitCode -ne 0) {
    throw "Sync did not complete (exit code $syncExitCode). Official DSH was restarted and the synchronizer backup was retained."
  }
  if ($null -ne $restartError) { throw $restartError }

  Write-Host 'Sync complete. Official DSH restarted and passed the health check.'
} finally {
  if ($mutexAcquired) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
  Stop-Transcript | Out-Null
}
