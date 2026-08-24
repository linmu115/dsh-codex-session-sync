import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DEFAULT_COOLDOWN_MS = 5000

export function resolveHelperPath() {
  return fileURLToPath(new URL('../scripts/sync-and-restart.ps1', import.meta.url))
}

export function buildPowerShellArgs({ helperPath, dshRoot, dshHome, healthUrl, nodeExecutable, dshProcessId, delaySeconds }) {
  if (!helperPath) throw new Error('helperPath is required')
  if (!dshRoot) throw new Error('dshRoot is required')
  if (!dshHome) throw new Error('dshHome is required')
  if (!healthUrl) throw new Error('healthUrl is required')
  if (!nodeExecutable) throw new Error('nodeExecutable is required')
  if (!Number.isInteger(dshProcessId) || dshProcessId < 1) throw new Error('dshProcessId is required')
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
    '-DshRoot',
    dshRoot,
    '-DshHome',
    dshHome,
    '-HealthUrl',
    healthUrl,
    '-NodeExecutable',
    nodeExecutable,
    '-DshProcessId',
    String(dshProcessId),
    '-DelaySeconds',
    String(delaySeconds),
  ]
}

function powerShellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function encodePowerShell(command) {
  return Buffer.from(command, 'utf16le').toString('base64')
}

export function buildPowerShellBootstrapArgs(options) {
  const helperArgs = buildPowerShellArgs(options)
  const helperPath = helperArgs[6]
  const parameterParts = []
  for (let index = 7; index < helperArgs.length; index += 2) {
    parameterParts.push(helperArgs[index], powerShellLiteral(helperArgs[index + 1]))
  }
  const innerCommand = [`& ${powerShellLiteral(helperPath)}`, ...parameterParts].join(' ')
  const innerEncoded = encodePowerShell(innerCommand)
  const brokerCommand = [
    "Start-Process -FilePath 'powershell.exe'",
    "-ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',",
    `${powerShellLiteral(innerEncoded)})`,
    '-WindowStyle Hidden',
  ].join(' ')
  return [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encodePowerShell(brokerCommand),
  ]
}

export function createSyncLauncher({
  spawnImpl = spawn,
  platform = process.platform,
  now = Date.now,
  cooldownMs = DEFAULT_COOLDOWN_MS,
} = {}) {
  let lastLaunchAt = Number.NEGATIVE_INFINITY

  return function launchSync({ dshRoot, dshHome, healthUrl, nodeExecutable, dshProcessId, delaySeconds = 2 }) {
    if (platform !== 'win32') return { launched: false, reason: 'unsupported-platform' }

    const launchedAt = now()
    if (launchedAt - lastLaunchAt < cooldownMs) {
      return { launched: false, reason: 'cooldown' }
    }

    const helperPath = resolveHelperPath()
    const args = buildPowerShellBootstrapArgs({ helperPath, dshRoot, dshHome, healthUrl, nodeExecutable, dshProcessId, delaySeconds })
    const child = spawnImpl('powershell.exe', args, {
      detached: false,
      stdio: 'ignore',
      windowsHide: true,
    })
    lastLaunchAt = launchedAt
    child.unref()
    return { launched: true, pid: child.pid }
  }
}
