import { createSyncLauncher } from './launcher.js'

export const name = 'codex-session-sync'
export const inject = ['commands']
export const CODEX_SYNC_COMMAND = 'codex-sync'
export const CODEX_SYNC_ACTION = 'sessions.sync'
export const PACKAGE_NAME = 'dsh-codex-session-sync'

const launchSync = createSyncLauncher()

function launchOptions(config = {}) {
  return {
    dshRoot: config.dshRoot || process.env.DSH_INSTALL_ROOT,
    dshHome: config.dshHome || process.env.DSH_HOME,
    healthUrl: config.healthUrl || process.env.DSH_WEB_URL || 'http://127.0.0.1:3080/',
    nodeExecutable: process.execPath,
    dshProcessId: process.pid,
    delaySeconds: config.delaySeconds ?? 2,
  }
}

function actionFailureMessage(reason) {
  if (reason === 'cooldown') return '刚刚已经启动过同步，请等待 DSH 完成重启。'
  return 'Codex 会话同步仅支持 Windows。'
}

export function registerCodexSyncCommand(ctx, launch = launchSync, config = {}) {
  ctx.effect(() => ctx.commands.register({
    name: CODEX_SYNC_COMMAND,
    description: 'sync Codex sessions into the official DSH home, then restart DSH',
    handler(invocation) {
      if (invocation.rawInput.trim() !== '') {
        return {
          kind: 'error',
          text: `Usage: /${CODEX_SYNC_COMMAND}`,
        }
      }

      try {
        const result = launch(launchOptions(config))
        if (!result.launched) {
          const text = result.reason === 'cooldown'
            ? 'A Codex session synchronization was just started. Wait for DSH to restart.'
            : 'Codex session synchronization is only supported on Windows.'
          return { kind: 'error', text }
        }
        return {
          kind: 'success',
          text: 'Codex session synchronization started. Official DSH will restart automatically.',
        }
      } catch (error) {
        return {
          kind: 'error',
          text: `Could not start Codex session synchronization: ${String(error)}`,
        }
      }
    },
  }), 'codex-session-sync: slash command')
}

export function registerCodexSyncAction(ctx, launch = launchSync, config = {}) {
  ctx.effect(() => ctx.resourceManagementActions.register(
    PACKAGE_NAME,
    CODEX_SYNC_ACTION,
    async () => {
      try {
        const result = launch(launchOptions(config))
        if (!result.launched) {
          return { ok: false, message: actionFailureMessage(result.reason) }
        }
        return {
          ok: true,
          message: '同步已启动，官方 DSH 将自动重启。',
        }
      } catch (error) {
        return {
          ok: false,
          message: `无法启动同步：${error instanceof Error ? error.message : String(error)}`,
        }
      }
    },
  ), 'codex-session-sync: Manager action')
}

export function apply(ctx, config = {}) {
  registerCodexSyncCommand(ctx, launchSync, config)
  ctx.inject(['resourceManagementActions'], (actionContext) => {
    registerCodexSyncAction(actionContext, launchSync, config)
  })
}
