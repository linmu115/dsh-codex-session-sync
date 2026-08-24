# Windows PowerShell helper 未执行修复

## 现象

Manager 已返回完整 `HTTP 200` 确认，但 DSH 没有停止、同步日志没有生成、会话同步也没有开始。直接前台运行同一 PowerShell 脚本则能正常完成。

## 根因

在当前 Windows PowerShell 5.1 环境中，Node 使用 `detached: true`、`windowsHide: true`、`stdio: ignore` 的组合启动 `powershell.exe -File` 时，子进程会立即以 0 退出，却不执行脚本。由于进程创建本身成功，旧 launcher 误报 `launched: true`。

## 修复

- PowerShell helper 改为非 detached 的独立 Windows 子进程。
- 继续使用 `windowsHide: true` 和 `stdio: ignore`，不弹窗口、不占用 DSH 的标准流。
- 继续调用 `unref()`，DSH 事件循环不会等待 helper；Windows 在父 Node 停止后不会自动结束该 PowerShell 进程。
- 版本提升至 `0.3.2`。

## 验证

- 无效 PID 探针确认非 detached PowerShell 能进入脚本并写入 transcript，且不会停止 DSH。
- 完整端到端验收检查浏览器先收到 JSON、helper 日志生成、旧 DSH PID 停止、新 PID 启动、3080 恢复健康。

## 回退

回退本提交并重新应用 `dsh-codex-session-sync@0.3.1`。回退后 Manager 仍能返回确认，但当前 Windows PowerShell 环境可能不会实际执行同步。
