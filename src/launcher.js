import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DEFAULT_COOLDOWN_MS = 5000

export function resolveHelperPath() {
  return fileURLToPath(new URL('../scripts/sync-and-restart.ps1', import.meta.url))
}

export function buildPowerShellArgs({ helperPath, eacRoot, delaySeconds }) {
  if (!helperPath) throw new Error('helperPath is required')
  if (!eacRoot) throw new Error('eacRoot is required')
  if (!Number.isInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > 30) {
    throw new Error('delaySeconds must be an integer between 0 and 30')
  }
  return [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    helperPath,
    '-EacRoot',
    eacRoot,
    '-DelaySeconds',
    String(delaySeconds),
  ]
}

export function createSyncLauncher({
  spawnImpl = spawn,
  platform = process.platform,
  now = Date.now,
  cooldownMs = DEFAULT_COOLDOWN_MS,
} = {}) {
  let lastLaunchAt = Number.NEGATIVE_INFINITY

  return function launchSync({ eacRoot, delaySeconds = 2 }) {
    if (platform !== 'win32') return { launched: false, reason: 'unsupported-platform' }

    const launchedAt = now()
    if (launchedAt - lastLaunchAt < cooldownMs) {
      return { launched: false, reason: 'cooldown' }
    }

    const helperPath = resolveHelperPath()
    const args = buildPowerShellArgs({ helperPath, eacRoot, delaySeconds })
    const child = spawnImpl('powershell.exe', args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    lastLaunchAt = launchedAt
    child.unref()
    return { launched: true, pid: child.pid }
  }
}

