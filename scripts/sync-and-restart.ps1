param(
  [Parameter(Mandatory = $true)]
  [string]$EacRoot,

  [ValidateRange(0, 30)]
  [int]$DelaySeconds = 2
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$eacRootPath = [System.IO.Path]::GetFullPath($EacRoot)
$eacExe = Join-Path $eacRootPath 'Deepseek Harness EAC.exe'
$nodeExe = Join-Path $eacRootPath 'resources\node\node.exe'
$pluginRoot = Split-Path -Parent $PSScriptRoot
$syncScript = Join-Path $pluginRoot 'sync\sync.mjs'
$logRoot = Join-Path $env:USERPROFILE '.dsh\codex-oneway-sync\plugin-runs'
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
  if (-not (Test-Path -LiteralPath $eacExe)) {
    throw "Cannot find EAC executable: $eacExe"
  }
  if (-not (Test-Path -LiteralPath $nodeExe)) {
    throw "Cannot find bundled Node executable: $nodeExe"
  }
  if (-not (Test-Path -LiteralPath $syncScript)) {
    throw "Cannot find bundled synchronizer: $syncScript"
  }

  if ($DelaySeconds -gt 0) {
    Start-Sleep -Seconds $DelaySeconds
  }

  Write-Host 'Stopping EAC to avoid concurrent session writes...'
  $eacProcesses = @(Get-Process | Where-Object {
    try {
      $_.Path -and [System.IO.Path]::GetFullPath($_.Path).StartsWith($eacRootPath, [System.StringComparison]::OrdinalIgnoreCase)
    } catch {
      $false
    }
  })

  foreach ($process in @($eacProcesses | Where-Object { $_.ProcessName -eq 'Deepseek Harness EAC' })) {
    try { [void]$process.CloseMainWindow() } catch { }
  }
  Start-Sleep -Seconds 2

  $remaining = @(Get-Process | Where-Object {
    try {
      $_.Path -and [System.IO.Path]::GetFullPath($_.Path).StartsWith($eacRootPath, [System.StringComparison]::OrdinalIgnoreCase)
    } catch {
      $false
    }
  })
  if ($remaining.Count -gt 0) {
    $remaining | Stop-Process -Force
    Start-Sleep -Milliseconds 500
  }

  $syncExitCode = 1
  $syncError = $null
  $restartError = $null
  try {
    Write-Host 'Syncing new and updated Codex sessions to EAC...'
    $env:NODE_NO_WARNINGS = '1'
    & $nodeExe $syncScript --apply --quiet --prune-redundant-branches
    $syncExitCode = $LASTEXITCODE
  } catch {
    $syncError = $_
  } finally {
    Write-Host 'Restarting EAC...'
    try {
      $eacProcess = Start-Process -FilePath $eacExe -WorkingDirectory $eacRootPath -PassThru
      $deadline = [DateTime]::UtcNow.AddSeconds(120)
      $healthy = $false
      while ([DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 500
        if ($eacProcess.HasExited) {
          throw "EAC exited before its web service became ready (exit code $($eacProcess.ExitCode))."
        }
        try {
          $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:51882/' -TimeoutSec 2
          if ($response.StatusCode -eq 200) {
            $healthy = $true
            break
          }
        } catch { }
      }
      if (-not $healthy) {
        throw 'EAC did not become healthy at http://127.0.0.1:51882/ within 120 seconds.'
      }
    } catch {
      $restartError = $_
    }
  }

  if ($null -ne $syncError) {
    throw $syncError
  }
  if ($syncExitCode -ne 0) {
    throw "Sync did not complete (exit code $syncExitCode). EAC was restarted and original data remains in backup."
  }
  if ($null -ne $restartError) {
    throw $restartError
  }

  Write-Host 'Sync complete. EAC was restarted and passed the health check.'
} finally {
  if ($mutexAcquired) {
    $mutex.ReleaseMutex()
  }
  $mutex.Dispose()
  Stop-Transcript | Out-Null
}

