import { createSyncLauncher } from './launcher.js'

export const name = 'codex-session-sync'
export const inject = ['commands']
export const CODEX_SYNC_COMMAND = 'codex-sync'

const DEFAULT_EAC_ROOT = 'D:\\AI\\Deepseek-Harness-EAC\\Deepseek Harness EAC'
const launchSync = createSyncLauncher()

export function registerCodexSyncCommand(ctx, launch = launchSync, config = {}) {
  const eacRoot = config.eacRoot || process.env.DSH_EAC_ROOT || DEFAULT_EAC_ROOT
  const delaySeconds = config.delaySeconds ?? 2

  ctx.effect(() => ctx.commands.register({
    name: CODEX_SYNC_COMMAND,
    description: 'sync Codex sessions into DSH, then restart EAC',
    handler(invocation) {
      if (invocation.rawInput.trim() !== '') {
        return {
          kind: 'error',
          text: `Usage: /${CODEX_SYNC_COMMAND}`,
        }
      }

      try {
        const result = launch({ eacRoot, delaySeconds })
        if (!result.launched) {
          const text = result.reason === 'cooldown'
            ? 'A Codex session synchronization was just started. Wait for EAC to restart.'
            : 'Codex session synchronization is only supported on Windows.'
          return { kind: 'error', text }
        }
        return {
          kind: 'success',
          text: 'Codex session synchronization started. EAC will close and restart automatically.',
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

