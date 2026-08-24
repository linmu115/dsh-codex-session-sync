import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  CODEX_SYNC_COMMAND,
  CODEX_SYNC_ACTION,
  PACKAGE_NAME,
  apply,
  registerCodexSyncAction,
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
  let injected
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
      inject(dependencies, callback) {
        injected = { dependencies, callback }
      },
    },
    command: () => command,
    dispose: () => dispose,
    injected: () => injected,
  }
}

test('plugin initialization registers explicit entry points and never launches synchronization', () => {
  const harness = createContext()
  apply(harness.ctx, { dshRoot: DSH_ROOT, dshHome: DSH_HOME, healthUrl: HEALTH_URL })

  assert.equal(harness.command().name, CODEX_SYNC_COMMAND)
  assert.equal(typeof harness.dispose(), 'function')
  assert.deepEqual(harness.injected().dependencies, ['resourceManagementActions'])
})

test('Manager action registers against the installed package and reports launch failures safely', async () => {
  let registration
  const effects = []
  const ctx = {
    resourceManagementActions: {
      register(packageName, actionId, handler) {
        registration = { packageName, actionId, handler }
        return () => undefined
      },
    },
    effect(factory) {
      effects.push(factory())
    },
  }
  const calls = []
  registerCodexSyncAction(ctx, (options) => {
    calls.push(options)
    return { launched: false, reason: 'cooldown' }
  }, { dshRoot: DSH_ROOT, dshHome: DSH_HOME, healthUrl: HEALTH_URL, delaySeconds: 2 })

  assert.equal(registration.packageName, PACKAGE_NAME)
  assert.equal(registration.actionId, CODEX_SYNC_ACTION)
  assert.equal(effects.length, 1)
  assert.deepEqual(await registration.handler(), {
    ok: false,
    message: '刚刚已经启动过同步，请等待 DSH 完成重启。',
  })
  assert.equal(calls.length, 1)
})

test('Manager action converts launcher exceptions into inline failure results', async () => {
  let handler
  const ctx = {
    resourceManagementActions: {
      register(_packageName, _actionId, nextHandler) {
        handler = nextHandler
        return () => undefined
      },
    },
    effect(factory) {
      factory()
    },
  }
  registerCodexSyncAction(ctx, () => { throw new Error('helper missing') })
  assert.deepEqual(await handler(), { ok: false, message: '无法启动同步：helper missing' })
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
  assert.doesNotMatch(helper, /51882|desktop shell/i)
})

test('package does not install shadow copies of DSH host services', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.dependencies, undefined)
  assert.equal(manifest.peerDependencies, undefined)
  assert.equal(manifest.devDependencies, undefined)
  assert.equal(manifest.files.includes('dsh-management'), true)
})
