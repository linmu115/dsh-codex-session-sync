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

const EAC_ROOT = 'D:\\AI\\Deepseek-Harness-EAC\\Deepseek Harness EAC'

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
  apply(harness.ctx, { eacRoot: EAC_ROOT })

  assert.equal(harness.command().name, CODEX_SYNC_COMMAND)
  assert.equal(typeof harness.dispose(), 'function')
})

test('command rejects arguments and launches exactly once for an explicit bare invocation', () => {
  const harness = createContext()
  const calls = []
  registerCodexSyncCommand(harness.ctx, (options) => {
    calls.push(options)
    return { launched: true, pid: 42 }
  }, { eacRoot: EAC_ROOT, delaySeconds: 2 })

  assert.equal(harness.command().handler({ rawInput: ' now' }).kind, 'error')
  assert.equal(calls.length, 0)

  const result = harness.command().handler({ rawInput: '' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /EAC/)
  assert.deepEqual(calls, [{ eacRoot: EAC_ROOT, delaySeconds: 2 }])
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

  assert.deepEqual(launch({ eacRoot: EAC_ROOT, delaySeconds: 2 }), { launched: true, pid: 77 })
  assert.deepEqual(launch({ eacRoot: EAC_ROOT, delaySeconds: 2 }), { launched: false, reason: 'cooldown' })
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
  assert.deepEqual(buildPowerShellArgs({ helperPath, eacRoot: EAC_ROOT, delaySeconds: 3 }), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    helperPath,
    '-EacRoot',
    EAC_ROOT,
    '-DelaySeconds',
    '3',
  ])
})

test('detached helper owns the stop-sync-restart lifecycle and a named mutex', async () => {
  const helper = await readFile(resolveHelperPath(), 'utf8')
  assert.match(helper, /DshCodexSessionSync/)
  assert.match(helper, /WaitOne\(0\)/)
  assert.match(helper, /--apply --quiet --prune-redundant-branches/)
  assert.match(helper, /Restarting EAC/)
  assert.match(helper, /127\.0\.0\.1:51882/)
})

test('package does not install shadow copies of DSH host services', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.dependencies, undefined)
  assert.equal(manifest.peerDependencies, undefined)
  assert.equal(manifest.devDependencies, undefined)
})
