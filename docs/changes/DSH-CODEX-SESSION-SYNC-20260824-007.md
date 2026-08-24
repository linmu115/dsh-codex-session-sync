# Windows 进程树独立化修复

## 现象

非 detached PowerShell 已能进入同步脚本并生成日志，但脚本停止父 DSH 后，当前 Launcher 的进程树管理会把 helper 一并回收。日志停在“Stopping official DSH”，3080 无法自动恢复。

## 根因

- `detached: true` 与当前隐藏 PowerShell 组合不会执行脚本。
- `detached: false` 能执行脚本，但 helper 仍是 DSH 的直接子进程，停止父进程时会被宿主进程树策略连带结束。

## 修复

- Node 启动一个短命、隐藏、非 detached 的 PowerShell broker。
- broker 使用 Windows `Start-Process -WindowStyle Hidden` 创建真正独立的同步 helper，然后立即退出。
- broker 与 helper 均使用 UTF-16LE Base64 `EncodedCommand`；路径和参数不再依赖命令行拼接或空格转义。
- helper 原有 PID 校验、互斥锁、备份、同步、重启与健康检查逻辑不变。
- 版本提升至 `0.3.3`。

## 验证

- 单元测试解码双层命令，验证隐藏独立启动、脚本路径、DSH PID 和延时参数。
- 正式端到端验收要求 helper 在旧 DSH PID 消失后继续运行、完成同步并启动新 PID。

## 回退

回退本提交并重新应用 `dsh-codex-session-sync@0.3.2`。回退后 helper 会在停止父 DSH 时被进程树策略回收。
