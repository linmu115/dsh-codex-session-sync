# Session Maintenance Phase 1 Read-only Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从空仓库交付一个独立、幂等、零平台写入的 DSH–Codex 会话版本内核，能够扫描 Codex/DSH、建立不可变版本图、识别快进与分叉，并通过 CLI 和本机 API 生成 dry-run 计划。

**Architecture:** 新 monorepo 将共享契约、纯领域逻辑、SQLite/Zstd 存储、平台只读适配器和 Engine 分开。为减少执行上下文，本计划只保存全局约束与跨批次接口；施工时只加载当前批次文件，不加载另外两个批次。

**Tech Stack:** Windows、Node.js `>=22.19.0`、pnpm `11.19.0`、TypeScript `5.9.2`、Vitest `3.2.4`、Zod `4.1.5`、Commander `14.0.0`、YAML `2.8.1`、`node:sqlite`、`node:zlib` Zstd、Node HTTP/SSE。

**Spec:** `../specs/2026-08-26-dsh-codex-session-maintenance-design.md`

**Roadmap:** `2026-08-26-dsh-codex-session-maintenance-roadmap.md`

## Global Constraints

- 目标仓库固定为 `D:\AI\DSH-Plugin-Repositories\dsh-session-maintenance`，分支使用 `codex/phase-1-readonly-core`。
- 阶段一只能读取平台；不得创建、修改、归档、删除或重启真实 Codex/DSH 会话。
- 新项目不得依赖、导入、启动或复制 `dsh-codex-session-sync`、`/codex-sync`、旧 PowerShell broker、EAC 或 Maintenance 服务。
- 旧提交 `1797669de0d7540def75bee90a5c9c5b15175455` 只能提供脱敏行为断言，不是运行依赖。
- 测试默认只使用带标记的 Windows 临时目录和仓库内合成 fixture；测试进程必须拒绝真实 `CODEX_HOME`、`DSH_HOME` 和正式 profile。
- Engine 是唯一编排入口；HTTP 只接受已登记 ID，不接受 `root`、`path`、`cwd` 或 `home`。
- HTTP 只监听 `127.0.0.1`；capability token 只存在于权限收紧的 connection file 和受信客户端，浏览器不得获得 Engine token。
- `scan` 只能建立版本并移动 observed platform ref；不得移动 canonical ref。
- 自动计划只覆盖可证明的前缀快进和单边元数据变化；分叉、重写和身份冲突必须进入人工处理。
- 版本图可以读取两父节点，但阶段一的扫描和计划不得创建两父版本或合成对话。
- Codex/DSH 版本、schema、Zstd 或事件 envelope 未命中适配器契约时只能诊断，不得猜测解析。
- 列表和首屏 API 不读取全部正文；变化候选的适配器读取并发上限固定为 `4`。
- 每个 P 任务必须有失败测试、目标测试、受影响回归、Markdown 修改报告和一个独立 Git 提交。
- 完成 P13 后停止；不得提前写平台、安装 DSH 插件或进入阶段二。

---

## 1. 按需加载规则

执行当前批次时只读取：

1. 已确认规格；
2. 本主计划；
3. 当前批次计划；
4. 当前任务实际涉及的源码。

不得为了执行 P1–P4 预读 P5–P13，也不得在每个任务重新载入整份总路线图。批次完成后把验证结果写入 `docs/validation/phase-1-progress.md`，再切换到下一批次。

| 批次 | 任务 | 计划文件 | 结束门禁 |
| --- | --- | --- | --- |
| A | P1–P4 | [foundation-and-domain](./2026-08-26-session-maintenance-phase-1-a-foundation-and-domain.md) | 干净 bootstrap；契约、规范化和版本图测试通过 |
| B | P5–P9 | [store-and-adapters](./2026-08-26-session-maintenance-phase-1-b-store-and-adapters.md) | 存储可重开；fixture 零泄漏；两平台只读适配器通过 |
| C | P10–P13 | [engine-and-acceptance](./2026-08-26-session-maintenance-phase-1-c-engine-and-acceptance.md) | 两次扫描零重复；CLI/API 只生成 dry-run；平台 hash 不变 |

## 2. 固定目录与职责

```text
dsh-session-maintenance/
├─ apps/engine/                    # CLI、编排、loopback API 和作业队列
├─ packages/contracts/             # 跨包 DTO、Zod schema 和错误码
├─ packages/session-domain/        # 规范化、版本图、差异、计划与发现
├─ packages/session-store/         # SQLite、Zstd 对象与 repository
├─ packages/adapter-codex-read/    # Codex 0.146.0 只读适配
├─ packages/adapter-dsh/           # DSH 0.1.1-rc.2 只读适配
├─ packages/local-api-client/      # 类型化本机 API 客户端
├─ packages/test-support/          # 临时 sandbox 和合成 fixture
├─ fixtures/{codex,dsh}/           # 人类可检查的脱敏 fixture 源
├─ tests/{contract,integration}/   # 跨包契约和阶段验收
├─ scripts/                        # bootstrap 与可迁移检查
└─ docs/{changes,validation}/       # 每任务报告和阶段证据
```

| 目录 | 包名 | 允许的内部依赖 |
| --- | --- | --- |
| `packages/contracts` | `@linmu/dsh-session-contracts` | 无 |
| `packages/session-domain` | `@linmu/dsh-session-domain` | contracts |
| `packages/session-store` | `@linmu/dsh-session-store` | contracts、domain |
| `packages/test-support` | `@linmu/dsh-session-test-support` | contracts |
| `packages/adapter-codex-read` | `@linmu/dsh-adapter-codex-read` | contracts、domain |
| `packages/adapter-dsh` | `@linmu/dsh-adapter-dsh` | contracts、domain |
| `packages/local-api-client` | `@linmu/dsh-session-api-client` | contracts |
| `apps/engine` | `@linmu/dsh-session-engine` | 上述生产包 |

内部依赖使用 `workspace:*`；所有包为 private ESM。库包的 `development` export 指向 `src/index.ts`，默认 export 指向 `dist/index.js`，禁止反向依赖 Engine、UI 或平台安装目录。

## 3. 跨批次接口

这些签名由批次 A 固定，批次 B/C 只能实现或使用，不得另建同义类型：

```ts
type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
type PlatformKind = "codex" | "dsh";
type SyncMode = "continuation" | "native-mirror" | "paused";
type CompatibilityStatus = "compatible" | "degraded" | "unsupported";

interface PlatformSessionKey { readonly platform: PlatformKind; readonly instanceId: string; readonly sessionId: string }
interface RegisteredInstance { readonly id: string; readonly platform: PlatformKind; readonly displayName: string; readonly root: string; readonly platformVersion: string }
interface CompatibilityIssue { readonly code: string; readonly message: string; readonly sourceType?: string }
interface CompatibilityReport { readonly status: CompatibilityStatus; readonly issues: readonly CompatibilityIssue[] }
interface AdapterContractRef { readonly adapter: string; readonly platformVersion: string; readonly schemaFingerprint: string }
interface ObservationHint { readonly size?: number; readonly mtimeNs?: string; readonly sourceHash?: string; readonly eventCount?: number }
interface StateFingerprint extends PlatformSessionKey { readonly kind: "catalog" | "content"; readonly value: string }
interface ScanCursor { readonly opaque: string }
interface PlatformSessionSummary { readonly key: PlatformSessionKey; readonly title: string; readonly archived: boolean; readonly workspaceId: string | null; readonly updatedAt: string; readonly hint: ObservationHint }
interface AdapterProbe { readonly status: CompatibilityStatus; readonly contract: AdapterContractRef; readonly capabilities: readonly ("list" | "observe" | "normalize" | "verify-read")[]; readonly issues: readonly CompatibilityIssue[] }
interface StableObservation { readonly kind: "stable"; readonly key: PlatformSessionKey; readonly fingerprint: StateFingerprint; readonly payload: unknown }
interface UnstableRead { readonly kind: "unstable"; readonly key: PlatformSessionKey; readonly reason: string; readonly retryable: true }
interface ExpectedPlatformState { readonly fingerprints: readonly StateFingerprint[] }
interface VerificationResult { readonly ok: boolean; readonly fingerprints: readonly StateFingerprint[]; readonly issues: readonly CompatibilityIssue[] }

interface Provenance extends PlatformSessionKey { readonly observedAt: string; readonly sourceVersion?: string }
interface SourceAnchor extends PlatformSessionKey { readonly eventId?: string; readonly sequence: number }
interface AttachmentRef { readonly name: string; readonly mediaType?: string; readonly source: string }
interface NormalizedEvent { readonly id: string; readonly parentId: string | null; readonly sequence: number; readonly kind: "message" | "tool-import" | "attachment" | "metadata"; readonly role: "user" | "assistant" | "system" | "tool" | "unknown"; readonly content: string; readonly attachments: readonly AttachmentRef[]; readonly source: SourceAnchor; readonly extensions: Readonly<Record<string, JsonValue>> }
interface NormalizedSession { readonly schemaVersion: 1; readonly key: PlatformSessionKey; readonly title: string; readonly archived: boolean; readonly workspaceId: string | null; readonly events: readonly NormalizedEvent[]; readonly bodyHash: string; readonly metadataHash: string; readonly provenance: Provenance; readonly compatibility: CompatibilityReport }
interface SessionVersionManifest { readonly schemaVersion: 1; readonly id: string; readonly logicalSessionId: string; readonly parents: readonly string[]; readonly bodyObject: string; readonly bodyHash: string; readonly metadataHash: string; readonly source: Provenance; readonly compatibility: CompatibilityReport }
interface LogicalSession { readonly id: string; readonly displayTitle: string; readonly canonicalVersionId: string | null; readonly syncMode: SyncMode; readonly archived: boolean; readonly labels: readonly string[]; readonly createdAt: string }
interface PlatformBinding { readonly id: string; readonly logicalSessionId: string; readonly key: PlatformSessionKey; readonly adapterContract: AdapterContractRef; readonly lastCommonVersionId: string | null; readonly status: "read-only" | "writable" | "busy" | "incompatible" }
interface MatchCandidate { readonly id: string; readonly leftBindingId: string; readonly rightKey: PlatformSessionKey; readonly reason: string; readonly confidence: "high" | "low" | "conflict"; readonly createdAt: string; readonly resolvedAt?: string }
interface Checkpoint { readonly id: string; readonly name: string; readonly description: string; readonly refs: Readonly<Record<string, string>>; readonly backupTransactionIds: readonly string[]; readonly createdBy: string; readonly createdAt: string }
interface VersionNode { readonly id: string; readonly parents: readonly string[] }
interface VersionGraphData { readonly nodes: readonly VersionNode[] }
interface NewVersion extends Omit<SessionVersionManifest, "schemaVersion" | "id"> {}
interface ObservedHead { readonly bindingId: string; readonly versionId: string; readonly observedAt: string; readonly fingerprint: StateFingerprint }
interface RepositoryCounts { readonly logicalSessions: number; readonly bindings: number; readonly versions: number; readonly candidates: number; readonly plans: number }
interface ObservationRecord { readonly logicalSession: LogicalSession; readonly binding: PlatformBinding; readonly version: SessionVersionManifest; readonly head: ObservedHead; readonly candidates: readonly MatchCandidate[] }
interface RepositoryWriteResult { readonly createdLogicalSessions: number; readonly createdBindings: number; readonly createdVersions: number; readonly createdCandidates: number }
interface GcPolicy { readonly reachableObjectIds: readonly string[]; readonly olderThan?: string; readonly dryRun: boolean }
interface GcReport { readonly reachableObjects: number; readonly retainedObjects: number; readonly deletedObjects: number; readonly deletedBytes: number }

interface BindingSnapshot { readonly bindingId: string; readonly key: PlatformSessionKey; readonly versionId: string; readonly fingerprints: readonly StateFingerprint[] }
interface ConfirmationRequirement { readonly kind: "review" | "destructive"; readonly code: string; readonly message: string }
type PlannedOperation =
  | { readonly type: "create-target-session"; readonly targetInstanceId: string }
  | { readonly type: "append-events"; readonly fromIndex: number; readonly eventIds: readonly string[] }
  | { readonly type: "update-title"; readonly title: string }
  | { readonly type: "update-archive"; readonly archived: boolean }
  | { readonly type: "deletion-candidate"; readonly missing: PlatformSessionKey }
  | { readonly type: "require-review"; readonly reason: "DIVERGED" | "REWRITTEN" | "METADATA_CONFLICT" | "IDENTITY_CONFLICT" };
interface ScanRequest { readonly instanceIds: readonly string[] }
interface DiffRequest { readonly logicalSessionId: string; readonly sourceBindingId?: string; readonly targetBindingId?: string }
interface PlanRequest extends DiffRequest { readonly sourceBindingId: string; readonly createdAt: string }
interface SyncPlan { readonly schemaVersion: 1; readonly id: string; readonly hash: string; readonly createdAt: string; readonly logicalSessionId: string; readonly baseVersionId?: string; readonly source: BindingSnapshot; readonly target?: BindingSnapshot; readonly adapterContracts: readonly AdapterContractRef[]; readonly operations: readonly PlannedOperation[]; readonly risk: "safe" | "review" | "destructive"; readonly confirmations: readonly ConfirmationRequirement[]; readonly preconditions: readonly StateFingerprint[] }
type JobStatus = "queued" | "running" | "completed" | "failed";
interface JobRef { readonly id: string; readonly status: JobStatus }
interface JobEventBase { readonly jobId: string; readonly sequence: number; readonly at: string }
type JobEvent =
  | (JobEventBase & { readonly type: "queued" | "running" })
  | (JobEventBase & { readonly type: "progress"; readonly current: number; readonly total?: number; readonly message: string })
  | (JobEventBase & { readonly type: "completed"; readonly result: JsonValue })
  | (JobEventBase & { readonly type: "failed"; readonly code: string; readonly message: string });

interface SessionReadAdapter {
  readonly platform: "codex" | "dsh";
  probe(instance: RegisteredInstance): Promise<AdapterProbe>;
  list(instance: RegisteredInstance, cursor?: ScanCursor): AsyncIterable<PlatformSessionSummary>;
  observe(instance: RegisteredInstance, key: PlatformSessionKey, hint?: ObservationHint): Promise<StableObservation | UnstableRead>;
  normalize(observation: StableObservation): Promise<NormalizedSession>;
  verify(instance: RegisteredInstance, key: PlatformSessionKey, expected: ExpectedPlatformState): Promise<VerificationResult>;
}

interface SessionRepository {
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

interface ContentObjectStore {
  put(bytes: Uint8Array): Promise<string>;
  get(hash: string): Promise<Uint8Array>;
  collect(policy: GcPolicy): Promise<GcReport>;
}

type SessionStatus = "unmapped" | "equal" | "source-ahead" | "target-ahead" | "diverged" | "rewritten" | "conflict" | "paused" | "unsupported";
interface Page<T> { readonly items: readonly T[]; readonly nextCursor?: string }
interface SessionQuery { readonly cursor?: string; readonly limit?: number; readonly platform?: PlatformKind; readonly status?: SessionStatus }
interface SessionSummary { readonly logicalSessionId: string; readonly title: string; readonly archived: boolean; readonly platforms: readonly PlatformKind[]; readonly status: SessionStatus; readonly updatedAt: string }
interface VersionGraphPage { readonly nodes: readonly SessionVersionManifest[]; readonly refs: readonly { readonly name: string; readonly versionId: string }[]; readonly nextCursor?: string }
interface InstanceStatus { readonly id: string; readonly platform: PlatformKind; readonly displayName: string; readonly compatibility: CompatibilityReport }
interface DiscoveryResult { readonly createdLogicalSessions: number; readonly createdBindings: number; readonly createdVersions: number; readonly createdCandidates: number; readonly platformWrites: 0 }
interface SessionDiff { readonly relation: "equal" | "source-ahead" | "target-ahead" | "diverged" | "unrelated"; readonly conversation: "unchanged" | "append-only" | "rewritten"; readonly metadata: "unchanged" | "source-only" | "target-only" | "metadata-conflict"; readonly mergeBase?: string }
interface EngineStatus { readonly ready: boolean; readonly instanceCount: number; readonly lastScanAt?: string }

interface ReadOnlyEngine {
  listInstances(): Promise<readonly InstanceStatus[]>;
  listSessions(query: SessionQuery): Promise<Page<SessionSummary>>;
  getGraph(id: string, cursor?: string): Promise<VersionGraphPage>;
  scan(request: ScanRequest): Promise<DiscoveryResult>;
  diff(request: DiffRequest): Promise<SessionDiff>;
  createPlan(request: PlanRequest): Promise<SyncPlan>;
  getPlan(id: string): Promise<SyncPlan | undefined>;
  status(): Promise<EngineStatus>;
}
```

阶段一 `applyPlan`、`restore` 和平台 write capability 必须返回 `CAPABILITY_NOT_AVAILABLE`。

## 4. 公共验证与提交约定

每个任务只在批次文档中列目标测试。通过目标测试后统一执行：

```powershell
pnpm typecheck
pnpm test
git diff --check
```

每个任务的修改报告使用：

```text
docs/changes/DSH-SESSION-MAINTENANCE-20260826-0NN.md
```

报告固定记录目标、修改文件、关键决策、测试命令及结果、遗留风险。报告和源码在同一个任务提交中；提交信息由批次计划固定。

阶段一最终命令固定为：

```powershell
pnpm verify:clean
pnpm test:phase1
pnpm assert:portable
git diff --check
git status --short --branch
```

## 5. 关键验收索引

| ID | 能力 | 阶段门禁 |
| --- | --- | --- |
| K1 | 干净 bootstrap/Windows CI | Node `22.19.0`、`24.x` 通过；第二次 bootstrap 不改 lockfile |
| K2 | 规范化/hash | 路径、时间、PID 不改 hash；标题只改 metadata hash；正文编辑必改 body hash |
| K3 | 版本图/决策 | equal、两向 fast-forward、diverged、rewritten、unrelated、metadata conflict 可区分 |
| K4 | SQLite/Zstd | 并发去重、重开、外键、损坏拒绝、schema 拒绝和 GC dry-run 通过 |
| K5 | 计划 | 同输入同 ID/hash；任一前置指纹差异返回 `PLAN_STALE` |
| K6 | Codex adapter | `0.146.0` 通过；列表不读正文；未知 schema unsupported |
| K7 | DSH adapter | `0.1.1-rc.2` 多帧通过；截断、magic、越界、逃逸和重复 ID 被拒绝 |
| K8 | 发现幂等 | 第二次扫描创建零 LogicalSession、Binding、Version |
| K9 | 绑定 | 明确 provenance 才自动绑定；同标题只候选；UUID 复用冲突 |
| K10 | 零平台写入 | scan/diff/plan/CLI/API 前后两平台树 hash 相同 |
| K11 | API/作业 | 鉴权、Origin、loopback、大小、路径限制和一次恢复通过 |
| K12 | 按需性能 | 1,000 会话二扫 `observe()=0`、首屏正文读取 `0`、并发 `<=4` |
| K13 | 可迁移性 | clean clone 通过；无本机路径、旧入口、EAC runtime 或本地路径依赖 |

## 6. 阶段一完成条件

- P1–P13 各自拥有一个修改报告和一个可审查提交。
- Windows Node `22.19.0` 与 `24.x` 的干净 bootstrap/CI 通过。
- 同一 fixture 扫描两次不会重复建立 LogicalSession、PlatformBinding 或 SessionVersion。
- 相等、快进、分叉、重写、标题冲突、归档和删除候选均有测试。
- `UNSTABLE_READ`、`PLAN_STALE`、`ADAPTER_INCOMPATIBLE`、`LIVE_HOME_FORBIDDEN` 和不支持写入均有测试。
- 扫描、比较和计划前后的 Codex/DSH fixture 文件 hash 完全一致。
- CLI/API 只能通过 instance ID 使用已登记路径，日志不包含会话正文或 capability token。
- `docs/validation/phase-1-validation.md` 包含真实环境、命令、提交和安全证据。
- 完成后停止并等待用户验收，再编写阶段二细化计划。
