import { createSyncLauncher } from './launcher.js'

export const name = 'codex-session-sync'
export const inject = ['commands']
export const CODEX_SYNC_COMMAND = 'codex-sync'

const launchSync = createSyncLauncher()

export function registerCodexSyncCommand(ctx, launch = launchSync, config = {}) {
  const dshRoot = config.dshRoot || process.env.DSH_INSTALL_ROOT
  const dshHome = config.dshHome || process.env.DSH_HOME
  const healthUrl = config.healthUrl || process.env.DSH_WEB_URL || 'http://127.0.0.1:3080/'
  const delaySeconds = config.delaySeconds ?? 2

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
        const result = launch({
          dshRoot,
          dshHome,
          healthUrl,
          nodeExecutable: process.execPath,
          dshProcessId: process.pid,
          delaySeconds,
        })
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

export function apply(ctx, config = {}) {
  registerCodexSyncCommand(ctx, launchSync, config)
}
