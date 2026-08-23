import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  CODEX_SYNC_COMMAND,
  apply,
  registerCodexSyncCommand,
} from '../src/index.js'
import {
  buildPowerShellArgs,
  createSyncLauncher,
  resolveHelperPath,
} from '../src/launcher.js'

const DSH_ROOT = 'D:\\AI\\DeepSeek-Harness'
const DSH_HOME = `${DSH_ROOT}\\home`
const HEALTH_URL = 'http://127.0.0.1:3080/'
const NODE_EXECUTABLE = 'D:\\nodejs\\node.exe'
const DSH_PROCESS_ID = 1234

function createContext() {
  let command
  let dispose
  return {
    ctx: {
      commands: {
        register(definition) {
          command = definition
          return () => undefined
        },
      },
      effect(factory) {
        dispose = factory()
      },
    },
    command: () => command,
    dispose: () => dispose,
  }
}

test('plugin initialization only registers /codex-sync and never launches synchronization', () => {
  const harness = createContext()
  apply(harness.ctx, { dshRoot: DSH_ROOT, dshHome: DSH_HOME, healthUrl: HEALTH_URL })

  assert.equal(harness.command().name, CODEX_SYNC_COMMAND)
  assert.equal(typeof harness.dispose(), 'function')
})

test('command rejects arguments and launches exactly once for an explicit bare invocation', () => {
  const harness = createContext()
  const calls = []
  registerCodexSyncCommand(harness.ctx, (options) => {
    calls.push(options)
    return { launched: true, pid: 42 }
  }, { dshRoot: DSH_ROOT, dshHome: DSH_HOME, healthUrl: HEALTH_URL, delaySeconds: 2 })

  assert.equal(harness.command().handler({ rawInput: ' now' }).kind, 'error')
  assert.equal(calls.length, 0)

  const result = harness.command().handler({ rawInput: '' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /Official DSH/)
  assert.deepEqual(calls, [{
    dshRoot: DSH_ROOT,
    dshHome: DSH_HOME,
    healthUrl: HEALTH_URL,
    nodeExecutable: process.execPath,
    dshProcessId: process.pid,
    delaySeconds: 2,
  }])
})

test('launcher uses a detached hidden PowerShell process and enforces a cooldown', () => {
  const spawns = []
  let unrefCount = 0
  const launch = createSyncLauncher({
    platform: 'win32',
    now: () => 1000,
    cooldownMs: 5000,
    spawnImpl(command, args, options) {
      spawns.push({ command, args, options })
      return { pid: 77, unref: () => { unrefCount += 1 } }
    },
  })

  const input = {
    dshRoot: DSH_ROOT,
    dshHome: DSH_HOME,
    healthUrl: HEALTH_URL,
    nodeExecutable: NODE_EXECUTABLE,
    dshProcessId: DSH_PROCESS_ID,
    delaySeconds: 2,
  }
  assert.deepEqual(launch(input), { launched: true, pid: 77 })
  assert.deepEqual(launch(input), { launched: false, reason: 'cooldown' })
  assert.equal(spawns.length, 1)
  assert.equal(spawns[0].command, 'powershell.exe')
  assert.equal(spawns[0].options.detached, true)
  assert.equal(spawns[0].options.windowsHide, true)
  assert.equal(spawns[0].options.stdio, 'ignore')
  assert.equal(unrefCount, 1)
})

test('PowerShell arguments preserve paths as individual argv values', () => {
  const helperPath = resolveHelperPath()
  assert.equal(existsSync(helperPath), true)
  assert.deepEqual(buildPowerShellArgs({
    helperPath,
    dshRoot: DSH_ROOT,
    dshHome: DSH_HOME,
    healthUrl: HEALTH_URL,
    nodeExecutable: NODE_EXECUTABLE,
    dshProcessId: DSH_PROCESS_ID,
    delaySeconds: 3,
  }), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    helperPath,
    '-DshRoot',
    DSH_ROOT,
    '-DshHome',
    DSH_HOME,
    '-HealthUrl',
    HEALTH_URL,
    '-NodeExecutable',
    NODE_EXECUTABLE,
    '-DshProcessId',
    String(DSH_PROCESS_ID),
    '-DelaySeconds',
    '3',
  ])
})

test('detached helper owns the stop-sync-restart lifecycle and a named mutex', async () => {
  const helper = await readFile(resolveHelperPath(), 'utf8')
  assert.match(helper, /DshCodexSessionSync/)
  assert.match(helper, /WaitOne\(0\)/)
  assert.match(helper, /--apply --quiet --prune-redundant-branches/)
  assert.match(helper, /Restarting official DSH/)
  assert.match(helper, /--dsh-home/)
  assert.doesNotMatch(helper, /EacRoot|Deepseek Harness EAC|51882/i)
})

test('package does not install shadow copies of DSH host services', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.dependencies, undefined)
  assert.equal(manifest.peerDependencies, undefined)
  assert.equal(manifest.devDependencies, undefined)
})
