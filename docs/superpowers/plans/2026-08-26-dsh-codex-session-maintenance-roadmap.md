# DSH–Codex Session Maintenance Delivery Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement each phase plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用四个独立验收阶段交付一个不依赖 EAC、旧同步插件或 Maintenance 服务的 DSH–Codex 会话版本管理、迁移与受控双向镜像系统。

**Architecture:** 全新 monorepo 以不可变会话版本图、SQLite 元数据和内容寻址对象库为核心；Codex 与 DSH 通过版本化适配器接入，Engine 是唯一业务入口。阶段一只读，阶段二开放 DSH 写入与 DSH 风格 Dashboard，阶段三创建原生 Codex 延续任务，阶段四才开放按会话白名单控制的 Codex 原生镜像。

**Tech Stack:** Windows、Node.js `>=22.19.0`、pnpm `11.19.0`、TypeScript `5.9.x`、Vitest `3.2.x`、Zod `4.1.x`、`node:sqlite`、`node:zlib` Zstd；后续 UI 使用 React 19、Vite 7、Lucide React 和固定版本的 `@linmu/dsh-management-kit@0.1.5`。

**Spec:** `../specs/2026-08-26-dsh-codex-session-maintenance-design.md`

## Global Constraints

- 目标源码仓库固定为 `D:\AI\DSH-Plugin-Repositories\dsh-session-maintenance`；当前 `dsh-codex-session-sync` 只保存设计与实施计划，不是新系统运行依赖。
- 不保留 `/codex-sync`、旧 ledger、旧 PowerShell broker、旧配置或 EAC 兼容层。
- 旧同步器基线 `1797669de0d7540def75bee90a5c9c5b15175455` 只能作为脱敏 fixture 和行为断言来源；新代码不得 import、spawn 或复制其运行入口。
- Engine、Dashboard、DSH 插件和 Codex 插件只共享已定义的 contracts；界面不得读取平台文件或直接访问 session store。
- UI/API 只能提交 `instanceId`、`sessionId`、`logicalSessionId` 和 `planId`，不能提交任意本机路径。
- `scan` 可以登记观察版本和移动 observed platform ref，但不能写平台或移动 canonical ref。
- 自动动作只允许可证明的前缀快进和单边元数据变化；对话分叉必须保留并进入人工处理。
- 默认 DSH → Codex 路径只创建延续任务；没有受支持创建入口时生成交接包，绝不切换成数据库写入。
- Codex 原生写入只在阶段四、明确版本 allowlist、停写窗口和逐会话白名单同时满足时启用。
- 归档可以按策略同步；删除、解除映射和显式重置是三个独立操作，删除永远确认。
- 所有测试默认只使用仓库内脱敏 fixture 和 Windows 临时目录；测试进程必须拒绝真实 `CODEX_HOME`、`DSH_HOME` 和正式 profile。
- 每个任务先写失败测试，再实现最小能力，通过本任务测试与受影响回归测试后单独提交。
- 每一阶段完成验收并提交验证报告后，才编写并执行下一阶段的细化计划。

---

## 1. 稳定跨阶段接口

以下包名和接口在阶段一固定；后续阶段扩展 union 成员，但不得在 UI 或适配器中另建同义模型。

```ts
export type PlatformKind = "codex" | "dsh";
export type SyncMode = "continuation" | "native-mirror" | "paused";

export interface PlatformSessionKey {
  readonly platform: PlatformKind;
  readonly instanceId: string;
  readonly sessionId: string;
}

export interface SessionReadAdapter {
  readonly platform: PlatformKind;
  probe(instance: RegisteredInstance): Promise<AdapterProbe>;
  list(instance: RegisteredInstance, cursor?: ScanCursor): AsyncIterable<PlatformSessionSummary>;
  observe(instance: RegisteredInstance, key: PlatformSessionKey, hint?: ObservationHint): Promise<StableObservation | UnstableRead>;
  normalize(observation: StableObservation): Promise<NormalizedSession>;
  verify(instance: RegisteredInstance, key: PlatformSessionKey, expected: ExpectedPlatformState): Promise<VerificationResult>;
}
```

```ts
export interface SessionRepository {
  createLogicalSession(input: LogicalSession): Promise<boolean>;
  findBinding(key: PlatformSessionKey): Promise<PlatformBinding | undefined>;
  bindPlatformSession(input: PlatformBinding): Promise<boolean>;
  getObservedHead(bindingId: string): Promise<ObservedHead | undefined>;
  putVersion(input: NewVersion): Promise<SessionVersionManifest>;
  recordObservation(input: ObservedHead): Promise<void>;
  recordObservedVersion(input: ObservationRecord): Promise<RepositoryWriteResult>;
  upsertMatchCandidate(input: MatchCandidate): Promise<boolean>;
  listMatchCandidates(logicalSessionId: string): Promise<readonly MatchCandidate[]>;
  listBindings(logicalSessionId: string): Promise<readonly PlatformBinding[]>;
  counts(): Promise<RepositoryCounts>;
  getGraph(logicalSessionId: string): Promise<VersionGraphData>;
  listSessions(query: SessionQuery): Promise<Page<SessionSummary>>;
  getGraphPage(logicalSessionId: string, cursor?: string): Promise<VersionGraphPage>;
  listReachableObjectIds(): Promise<readonly string[]>;
  savePlan(plan: SyncPlan): Promise<void>;
  getPlan(id: string): Promise<SyncPlan | undefined>;
}

export interface ContentObjectStore {
  put(bytes: Uint8Array): Promise<string>;
  get(hash: string): Promise<Uint8Array>;
  collect(policy: GcPolicy): Promise<GcReport>;
}
```

```ts
export interface SessionMaintenanceEngine {
  scan(request: ScanRequest): Promise<JobRef>;
  createPlan(request: PlanRequest): Promise<SyncPlan>;
  applyPlan(request: ApplyPlanRequest): Promise<JobRef>;
  verify(transactionId: string): Promise<VerificationResult>;
  restore(request: RestoreRequest): Promise<JobRef>;
  subscribe(jobId: string): AsyncIterable<JobEvent>;
}

export interface MaintenanceClient {
  listSessions(query: SessionQuery): Promise<Page<SessionSummary>>;
  getGraph(id: string, cursor?: string): Promise<VersionGraphPage>;
  getDiff(request: DiffRequest): Promise<SessionDiff>;
  scan(request: ScanRequest): Promise<JobRef>;
  createPlan(request: PlanRequest): Promise<SyncPlan>;
  applyPlan(request: ApplyPlanRequest): Promise<JobRef>;
  restore(request: RestoreRequest): Promise<JobRef>;
  subscribe(jobId: string): AsyncIterable<JobEvent>;
}
```

阶段一对 `applyPlan`、`verify` 和 `restore` 返回明确的 `CAPABILITY_NOT_AVAILABLE`；接口先固定，但平台写能力只在对应阶段启用。

## 2. 阶段与验收门

### 阶段一：独立只读内核

阶段一主索引：[2026-08-26-session-maintenance-phase-1-readonly-core.md](./2026-08-26-session-maintenance-phase-1-readonly-core.md)。为避免执行时反复加载无关任务，细节拆为三个按需读取的批次：

- [P1–P4：工程、契约与领域模型](./2026-08-26-session-maintenance-phase-1-a-foundation-and-domain.md)
- [P5–P9：存储、fixture 与只读适配器](./2026-08-26-session-maintenance-phase-1-b-store-and-adapters.md)
- [P10–P13：发现、Engine/API 与验收](./2026-08-26-session-maintenance-phase-1-c-engine-and-acceptance.md)

| ID | 可独立验收的交付物 | 规格覆盖 |
| --- | --- | --- |
| P1 | 新 monorepo、Bootstrap、Windows CI 和零旧运行依赖检查 | §1、§3–§6、§22 |
| P2 | 跨包 contracts、领域 ID、状态和错误码的运行时校验 | §5、§8.1、§16 |
| P3 | 规范化、稳定正文/元数据 hash 和来源降格模型 | §8.2、§13、§19.1 |
| P4 | 版本图、ref、前缀、分叉和元数据冲突判定 | §5.2、§8.3、§9、§10 |
| P5 | SQLite WAL、内容寻址 Zstd 对象库、去重和安全 GC | §8、§18、§19.1 |
| P6 | 不可变 SyncPlan、计划 hash、风险与 `PLAN_STALE` | §5.2、§7、§9、§16 |
| P7 | fixture sandbox 与禁止读取 live home 的测试护栏 | §12、§19.2/3 |
| P8 | Codex `0.146.0` 只读适配器与未知 schema 诊断 | §6、§9、§12.3、§19.2 |
| P9 | 官方 DSH `0.1.1-rc.2` 只读适配器与 Zstd 多帧解析 | §6、§9、§13、§19.2 |
| P10 | 不依赖旧 ledger 的干净发现、匹配候选和幂等基线 | §2.1、§17、§19.3、§21 |
| P11 | Engine CLI 的 `instance/scan/diff/plan/status` 与 dry-run | §7、§9、§20.1 |
| P12 | loopback API、capability token、作业队列和事件流 | §6.1、§7.1、§18 |
| P13 | 阶段一全量验收、可迁移性检查和验证报告 | §2.2、§17–§21 |

阶段一验收门：从空维护目录扫描两套 fixture 两次，第二次产生零重复版本；能够区分相等、快进、分叉、重写、归档和删除候选；CLI/API 只能生成 dry-run 计划，平台文件 hash 在执行前后完全一致。

### 阶段二：DSH 安全写入与 DSH 风格界面

阶段二开始前以 P13 的真实类型、数据库 schema 和适配器契约进行新的 `writing-plans` 细化，不提前修改这些基线。

| ID | 固定交付边界 | 规格覆盖 |
| --- | --- | --- |
| P14 | 通用 transaction journal、备份、checkpoint、恢复和受保护 GC | §8、§16、§18 |
| P15 | DSH writer、workspace/projection 验证与恢复 | §7、§16、§19.2 |
| P16 | Codex → DSH 安全快进、DSH 分支保留和故障注入 | §9、§19.3、§21 |
| P17 | `local-api-client` 完整查询/操作 DTO 与分页、事件流 | §6.1、§15、§18 |
| P18 | DSH 风格 Dashboard 壳、概览、会话列表和共享 UI 基线 | §15.2 |
| P19 | 会话 GitGraph、三方差异、计划预览和 checkpoint 页面 | §10、§15.2、§16 |
| P20 | 事务恢复、适配器诊断和设置页面 | §15.2、§16 |
| P21 | DSH 版本锁定的会话右键适配器和轻量参数/操作面板 | §15.1、§15.3 |
| P22 | 新插件打包、正式 profile 验收；通过后卸载旧同步插件 | §17、§20.2、§21 |

UI 基线固定为 Maintenance 仓库 `e0e5c6a142b5cad5439c770c33f636c17c6eecc8` 中的 `@linmu/dsh-management-kit@0.1.5`。阶段二先核对许可证，再把带 SHA-256 和来源记录的 tgz 放入新仓库 `vendor/`，由 Vite/插件构建打包；运行时不得依赖 Maintenance。`GitGraphCanvas` 不属于 kit，必须在 `packages/session-ui` 中按会话图语义独立实现。

### 阶段三：Codex 延续任务与 Codex 官方入口

| ID | 固定交付边界 | 规格覆盖 |
| --- | --- | --- |
| P23 | 探测并锁定受支持的新任务入口；不可用时只生成交接包 | §11.1 |
| P24 | 上下文预算、完整交接与用户确认的“摘要 + 可追溯归档” | §11.1、§13 |
| P25 | 创建、验证并绑定可 resume 的原生 Codex 延续任务 | §11.1、§20.3 |
| P26 | Codex Skill、MCP 工具和工具卡片，不注入原生侧栏 | §15.4 |
| P27 | 两父解析版本和“基于双方创建延续任务” | §10 |
| P28 | DSH → Codex 延续任务端到端验收与打包 | §19.3/4、§21 |

阶段三只调用 Codex 受支持的任务创建入口。入口缺失或失败时返回交接包，不得调用阶段四的原生写适配器。

### 阶段四：受控 Codex 原生镜像

| ID | 固定交付边界 | 规格覆盖 |
| --- | --- | --- |
| P29 | Codex schema 指纹、脱敏 fixture、版本 allowlist 和升级暂停 | §12 |
| P30 | Codex 停写检测、空间检查和完整相关文件备份集 | §11.2、§12.1 |
| P31 | 候选存储、跨文件校验、原子发布和 journal 逆序恢复 | §12.2、§16 |
| P32 | DSH 工具事件降格与不可伪造的 provenance | §13 |
| P33 | 逐会话白名单、镜像状态机、标题与归档同步 | §11.2、§14 |
| P34 | 冲突、显式重置、解除映射、删除确认和恢复 UI | §10、§14–§16 |
| P35 | 每个事务步骤故障注入及未知 Codex 版本零写入测试 | §12.3、§19 |
| P36 | 全量验收、正式 profile 切换和旧插件退出确认 | §17、§21 |

阶段四验收门要求当前 Codex 版本、关键文件集合和 schema 指纹全部命中 allowlist；Codex 忙碌、版本未知或恢复未完成时必须零写入。该阶段不通过不会阻止前三阶段作为稳定产品使用。

## 3. 依赖与执行顺序

```text
P1 -> P2 -> P3 -> P4 -> P5 -> P6
             \-> P7 -> P8 -> P9 -\
P4 + P5 + P8 + P9 -> P10 -> P11 -> P12 -> P13

P13 -> P14 -> P15 -> P16 -> P17 -> P18 -> P19 -> P20 -> P21 -> P22
P22 -> P23 -> P24 -> P25 -> P26 -> P27 -> P28
P28 -> P29 -> P30 -> P31 -> P32 -> P33 -> P34 -> P35 -> P36
```

在 Inline Execution 中仍按任务串行提交；图中的并行关系只说明模块依赖，不授权同时改同一工作树。

## 4. 计划与报告位置

- 设计规格：`docs/superpowers/specs/2026-08-26-dsh-codex-session-maintenance-design.md`
- 阶段计划：`docs/superpowers/plans/`
- 每任务修改/排错记录：目标新仓库 `docs/changes/DSH-SESSION-MAINTENANCE-YYYYMMDD-NNN.md`
- 每阶段验收：目标新仓库 `docs/validation/phase-N-validation.md`

阶段一的 P1 会把已确认规格、总路线、阶段一主索引和三个批次计划复制到新仓库并作为首个文档提交的一部分；后续实现只在新仓库进行。
