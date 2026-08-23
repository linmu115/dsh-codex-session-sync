# DSH-CODEX-SESSION-SYNC-20260823-001

## Goal

Turn the existing double-click Codex-to-EAC session synchronizer into a self-contained DSH plugin without changing its UUID-aware synchronization behavior or running synchronization during installation and startup.

## Before

- Git baseline: `2596b46` (`chore: initialize Codex session sync plugin`).
- The synchronization entry existed only as `D:\AI\Deepseek-Harness-EAC\同步 Codex 会话到 EAC.cmd` and depended on files under a separate pipeline directory.
- DSH had no command entry for the workflow.

## Changes

- Added the host-only `/codex-sync` command.
- Added an argv-safe detached PowerShell launcher. It does not use shell string interpolation.
- Added a five-second in-process launch cooldown and the `Local\DshCodexSessionSync` mutex for the complete helper lifecycle.
- Bundled the tested `sync.mjs` implementation and its Codex converter dependencies, including the upstream MIT license and provenance note.
- Added a PowerShell helper that delays briefly, stops only processes whose executable path is inside the configured EAC root, applies synchronization, restarts EAC, and verifies `http://127.0.0.1:51882/`.
- Added persistent helper logs below `~/.dsh/codex-oneway-sync/plugin-runs`.
- Kept the runtime package dependency-free. This is required by EAC `4.4.1` with DSH `0.1.1-rc.2`: optional host peer declarations caused pnpm to materialize older DSH service copies in the profile, which EAC correctly removed as installation-closure shadows on cold start.
- Added command, detached-launch, lifecycle-contract, UUID deduplication, incremental update, branch preservation, redundant-branch pruning, Zstd, and projection-cache tests.

## Safety

- Plugin initialization only registers a command; it never launches synchronization.
- Tests use temporary fixtures and do not touch live session data.
- Installing the bundle does not execute `/codex-sync`.
- The original double-click entry is preserved.

## Verification

- `pnpm check`: 13/13 tests passed, including the temporary-directory synchronization integration test.
- Windows PowerShell parsed `scripts/sync-and-restart.ps1` successfully.
- `pnpm pack` produced `D:\AI\DSH-Plugin-Packages\dsh-codex-session-sync-0.1.1.tgz` with only the declared runtime files.
- Installed through the active EAC runtime's official DSH `0.1.1-rc.2` CLI into `web-desktop`.
- After a cold EAC restart, the dependency and bundle registration remained present, the composed DSH config contained `codex-session-sync`, and `http://127.0.0.1:51882/` returned HTTP 200.
- The EAC command menu displayed `codex-sync — sync Codex sessions into DSH, then restart EAC`.
- The command was not submitted. No helper process arguments or `plugin-runs` log appeared, confirming that install/startup does not synchronize live sessions.
- DSH Maintenance reported package `0.1.1` on `main` as clean and healthy, and rendered the repository history, README, and this version log.

## Rollback

The annotated rollback tag for this change is `change/DSH-CODEX-SESSION-SYNC-20260823-001`.
