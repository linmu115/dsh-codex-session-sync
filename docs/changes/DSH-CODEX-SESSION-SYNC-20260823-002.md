# DSH-CODEX-SESSION-SYNC-20260823-002

## 目标

移除 `/codex-sync` 对 EAC 可执行文件、内置 Node、看门狗和 51882 端口的运行依赖，使插件只操作独立的官方 DSH 安装与 `DSH_HOME`。

## 修改前

- bundle 配置要求 `eacRoot`。
- helper 会枚举并停止 EAC 目录中的进程，再从 EAC 安装目录启动桌面壳。
- 同步目标隐式使用用户目录下的 `.dsh`，无法保证与当前官方 DSH home 一致。

## 修改后

- 配置改为 `dshRoot`、`dshHome`、`healthUrl`，Node 路径和当前 DSH PID由插件运行时传入。
- helper 校验 PID 的命令行属于配置的官方 DSH 根目录，只停止该 DSH 进程。
- 同步器显式接收 `--dsh-home`，完成后调用 `Start-Official-DSH.ps1 -NoOpen` 并验证 Web UI。
- EAC 不再被探测、停止、启动或用于提供 Node。
- 历史 ledger 中带 `EAC` 的字段与分支 ID 暂时保留，仅用于兼容已有同步数据。

## 回退

回退到上一 Git 提交并重新打包 `dsh-codex-session-sync@0.1.1`。该旧版本只能用于原 EAC 启停流程，不应部署到独立官方 DSH profile。

## 验证

- `pnpm check`
- PowerShell parser validation for `scripts/sync-and-restart.ps1`
- official DSH `web` profile composition and plugin asset HTTP check
