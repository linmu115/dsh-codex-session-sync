# Session Maintenance Phase 1 Read-only Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从空仓库交付一个独立、幂等、零平台写入的 DSH–Codex 会话版本内核，能够扫描脱敏或用户登记的 Codex/DSH 实例、建立不可变版本图、识别快进与分叉，并通过 CLI/loopback API 生成可审查的 dry-run 计划。

**Architecture:** 新 monorepo 把跨进程 DTO、纯领域算法、SQLite/内容寻址存储和两个只读平台适配器分开。Engine 通过注册过的 instance ID 解析真实根目录；CLI 是可信本地配置入口，HTTP API 只接受逻辑 ID，并用 capability token、loopback 绑定和持久化作业队列限制访问。

**Tech Stack:** Windows、Node.js `>=22.19.0`、pnpm `11.19.0`、TypeScript `5.9.2`、Vitest `3.2.4`、Zod `4.1.5`、Commander `14.0.0`、YAML `2.8.1`、`node:sqlite`、`node:zlib` Zstd、Node HTTP/SSE。

**Spec:** `../specs/2026-08-26-dsh-codex-session-maintenance-design.md`

**Roadmap:** `2026-08-26-dsh-codex-session-maintenance-roadmap.md`

**Planning baseline:** `dsh-codex-session-sync/main@0ca00ce`。计划执行会创建全新仓库 `D:\AI\DSH-Plugin-Repositories\dsh-session-maintenance`；旧仓库不提供 runtime package。

## Global Constraints

- 阶段一只允许读取平台；不得创建、修改、归档、删除或重启任何真实 Codex/DSH 会话。
- 新项目不得依赖、import、spawn 或复制 `dsh-codex-session-sync` 的运行代码；历史提交 `1797669de0d7540def75bee90a5c9c5b15175455` 只提供行为断言来源。
- 不读取旧 ledger，不实现 `/codex-sync`，不增加 EAC 或 Maintenance 服务适配。
- Node engine 固定为 `>=22.19.0`，package manager 固定为 `pnpm@11.19.0`；Windows CI 同时验证 Node `22.19.0` 和 `24.x`。
- 会话正文版本不可变；扫描只移动 observed platform ref，不移动 canonical ref。
- 正文 hash 排除扫描时间、本机绝对路径、进程 ID、端口和日志位置；标题/归档只影响 metadata hash。
- 标题不能单独触发跨平台自动绑定；自动匹配只接受显式 provenance 或可证明的稳定身份。
- 读取期间文件变化返回 `UNSTABLE_READ`，不建立版本。
- 所有外部输入经过 Zod 校验；UI/API 不接受磁盘路径，只接受已登记 instance/session/logical/plan ID。
- 默认测试命令必须从进程级拒绝真实 `CODEX_HOME`、`DSH_HOME` 和正式 profile。
- 每个任务写一份 `docs/changes/DSH-SESSION-MAINTENANCE-YYYYMMDD-NNN.md`，与源码和测试同一提交。
- 每个任务单独提交；任务结束前运行本任务测试、受影响回归测试和 `git diff --check`。

---

## Phase 1 target tree

```text
dsh-session-maintenance/
├─ .github/workflows/ci.yml
├─ docs/
│  ├─ superpowers/specs/
│  ├─ superpowers/plans/
│  ├─ changes/
│  └─ validation/
├─ apps/engine/
│  ├─ package.json
│  └─ src/{cli.ts,composition-root.ts,engine.ts,config.ts,main.ts,http/,jobs/}
├─ packages/
│  ├─ contracts/src/{model.ts,adapters.ts,plans.ts,jobs.ts,http.ts,schemas.ts,errors.ts,index.ts}
│  ├─ session-domain/src/{canonical-json.ts,normalize.ts,graph.ts,diff.ts,planner.ts,index.ts}
│  ├─ session-store/src/{database.ts,schema.ts,object-store.ts,repository.ts,index.ts}
│  ├─ adapter-codex-read/src/{probe.ts,catalog.ts,stable-read.ts,parser.ts,normalizer.ts,index.ts}
│  ├─ adapter-dsh/src/{probe.ts,zstd-codec.ts,reader.ts,normalizer.ts,index.ts}
│  ├─ local-api-client/src/{client.ts,event-stream.ts,index.ts}
│  └─ test-support/src/{sandbox.ts,codex-fixture.ts,dsh-fixture.ts,index.ts}
├─ fixtures/{codex/0.146.0,dsh/0.1.1-rc.2}/
├─ scripts/{bootstrap.mjs,assert-portable.mjs}
├─ tests/{contract,integration}/
├─ package.json
├─ pnpm-lock.yaml
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
└─ vitest.config.ts
```

## Workspace package contract

Phase-one package identities and dependency direction are fixed:

| Directory | Package name | Runtime dependencies |
| --- | --- | --- |
| `packages/contracts` | `@linmu/dsh-session-contracts` | `zod@4.1.5` |
| `packages/session-domain` | `@linmu/dsh-session-domain` | contracts |
| `packages/session-store` | `@linmu/dsh-session-store` | contracts, domain |
| `packages/test-support` | `@linmu/dsh-session-test-support` | contracts |
| `packages/adapter-codex-read` | `@linmu/dsh-adapter-codex-read` | contracts, domain |
| `packages/adapter-dsh` | `@linmu/dsh-adapter-dsh` | contracts, domain |
| `packages/local-api-client` | `@linmu/dsh-session-api-client` | contracts |
| `apps/engine` | `@linmu/dsh-session-engine` | all phase-one production packages, `commander@14.0.0`, `yaml@2.8.1` |

Internal dependencies use `workspace:*`. Every library package is private ESM and uses this export/build contract so Vitest reads source while built Node processes read `dist`:

```json
{
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "development": "./src/index.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

Each package `tsconfig.json` extends `../../tsconfig.base.json`, sets `rootDir: "src"`, `outDir: "dist"`, and includes only `src/**/*.ts`; tests are typechecked by the root Vitest/TypeScript test configuration rather than emitted into package output. `vitest.config.ts` explicitly adds:

```ts
resolve: { conditions: ["development", "node", "import", "default"] },
```

The Engine package adds `"bin": { "dsh-session-maint": "./dist/main.js" }`; its `main.ts` begins with `#!/usr/bin/env node`. No package may depend upward on Engine, adapters, UI, or a platform installation.

---

### Task P1: Create the independent monorepo and clean Windows bootstrap

**Files:**
- Create repository: `D:\AI\DSH-Plugin-Repositories\dsh-session-maintenance`
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `AGENTS.md`
- Create: `scripts/bootstrap.mjs`
- Create: `.github/workflows/ci.yml`
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/index.ts`
- Create: `tests/contract/workspace-contract.test.ts`
- Create: `docs/changes/DSH-SESSION-MAINTENANCE-20260826-001.md`
- Copy by patch: confirmed spec, roadmap, and this phase plan into the same paths below the new repository `docs/superpowers/`

**Interfaces:**
- Consumes: Node.js `>=22.19.0`, pnpm `11.19.0`, the three committed planning documents.
- Produces: clean repository `dsh-session-maintenance`, branch `codex/phase-1-readonly-core`, root commands `pnpm bootstrap`, `pnpm check`, `pnpm verify:clean`, package `@linmu/dsh-session-contracts`.

- [ ] **Step 1: Initialize the repository and add the workspace contract test**

Run once:

```powershell
New-Item -ItemType Directory -Path 'D:\AI\DSH-Plugin-Repositories\dsh-session-maintenance'
git -C 'D:\AI\DSH-Plugin-Repositories\dsh-session-maintenance' init -b main
git -C 'D:\AI\DSH-Plugin-Repositories\dsh-session-maintenance' switch -c codex/phase-1-readonly-core
```

Use `apply_patch` to add the root files. `package.json` starts with these exact scripts and versions:

```json
{
  "name": "dsh-session-maintenance-workspace",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.19.0",
  "engines": { "node": ">=22.19.0" },
  "scripts": {
    "bootstrap": "node scripts/bootstrap.mjs",
    "build": "pnpm -r --if-present build",
    "typecheck": "pnpm -r --if-present typecheck",
    "test": "vitest run",
    "check": "pnpm typecheck && pnpm build && pnpm test",
    "verify:clean": "pnpm bootstrap && pnpm check"
  },
  "devDependencies": {
    "@types/node": "24.3.0",
    "typescript": "5.9.2",
    "vitest": "3.2.4"
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - apps/*
  - packages/*
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["development", "node", "import", "default"] },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: ["**/.worktrees/**", "tests/e2e/**"],
    testTimeout: 15_000,
    maxWorkers: 2,
    environment: "node",
  },
});
```

The first test must reject accidental coupling:

```ts
// tests/contract/workspace-contract.test.ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("workspace contract", () => {
  it("is an independent pnpm workspace", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    const workspace = await readFile("pnpm-workspace.yaml", "utf8");
    expect(pkg.packageManager).toBe("pnpm@11.19.0");
    expect(pkg.engines.node).toBe(">=22.19.0");
    expect(workspace).toContain("apps/*");
    expect(workspace).toContain("packages/*");
    expect(JSON.stringify(pkg)).not.toContain("dsh-codex-session-sync");
    expect(JSON.stringify(pkg)).not.toContain("EAC");
  });
});
```

- [ ] **Step 2: Install once and verify the bootstrap contract initially fails**

Run:

```powershell
corepack enable
pnpm install
pnpm vitest run tests/contract/workspace-contract.test.ts
node scripts/bootstrap.mjs
```

Expected: the Vitest contract passes; `node scripts/bootstrap.mjs` fails because the bootstrap implementation is not yet present or does not enforce the pinned toolchain.

- [ ] **Step 3: Implement deterministic bootstrap and minimal contracts export**

`scripts/bootstrap.mjs` must resolve the repository root from `import.meta.url`, verify Node `>=22.19.0`, verify `packageManager === "pnpm@11.19.0"`, and invoke pnpm without a shell:

```js
const result = spawnSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["install", "--frozen-lockfile"], {
  cwd: root,
  stdio: "inherit",
  shell: false,
});
if (result.status !== 0) process.exit(result.status ?? 1);
```

Create `@linmu/dsh-session-contracts` with ESM output and a first stable constant:

```ts
// packages/contracts/src/index.ts
export const CONTRACT_SCHEMA_VERSION = 1 as const;
```

The package scripts are:

```json
{
  "name": "@linmu/dsh-session-contracts",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": { "types": "./src/index.ts", "development": "./src/index.ts", "default": "./dist/index.js" } },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": { "zod": "4.1.5" }
}
```

- [ ] **Step 4: Add clean Windows CI and project rules**

`.github/workflows/ci.yml` uses a two-version Windows matrix:

```yaml
name: phase-1-check
on:
  pull_request:
  push:
    branches: [main]
jobs:
  clean-windows:
    runs-on: windows-latest
    strategy:
      matrix:
        node: [22.19.0, 24.x]
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 11.19.0 }
      - uses: actions/setup-node@v4
        with: { node-version: "${{ matrix.node }}", cache: pnpm }
      - run: pnpm bootstrap
      - run: pnpm check
      - shell: pwsh
        run: if (git status --porcelain) { git status --short; throw 'check changed tracked files' }
```

`AGENTS.md` repeats the phase-one read-only rule, fixture-only test rule, one-task-one-commit rule, and prohibition on EAC/legacy imports. The first change report records the repository path, tool versions, files created, commands run and results.

- [ ] **Step 5: Verify the clean bootstrap**

Run:

```powershell
pnpm bootstrap
pnpm check
git diff --check
git status --short
```

Expected: all commands pass; only the intended new files are untracked/staged, and `pnpm-lock.yaml` is stable on a second `pnpm bootstrap`.

- [ ] **Step 6: Commit P1**

```powershell
git add .
git commit -m "chore: bootstrap session maintenance workspace"
```

---

### Task P2: Define cross-package contracts and runtime schemas

**Files:**
- Create: `packages/contracts/src/model.ts`
- Create: `packages/contracts/src/adapters.ts`
- Create: `packages/contracts/src/store.ts`
- Create: `packages/contracts/src/plans.ts`
- Create: `packages/contracts/src/jobs.ts`
- Create: `packages/contracts/src/http.ts`
- Create: `packages/contracts/src/schemas.ts`
- Create: `packages/contracts/src/errors.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/test/contracts.test.ts`
- Create: `docs/changes/DSH-SESSION-MAINTENANCE-20260826-002.md`

**Interfaces:**
- Consumes: `CONTRACT_SCHEMA_VERSION = 1`, Zod `4.1.5`.
- Produces: the only shared DTOs for adapters, store, Engine, CLI, API and later UI; error codes `UNSTABLE_READ`, `PLAN_STALE`, `ADAPTER_INCOMPATIBLE`, `CAPABILITY_NOT_AVAILABLE`, `LIVE_HOME_FORBIDDEN`, `RECOVERY_REQUIRED`.

- [ ] **Step 1: Write failing serialization and validation tests**

```ts
// packages/contracts/test/contracts.test.ts
import { describe, expect, it } from "vitest";
import { platformSessionKeySchema, sessionVersionManifestSchema } from "../src/index.js";

describe("session contracts", () => {
  it("rejects unknown platforms and versions with more than two parents", () => {
    expect(platformSessionKeySchema.safeParse({ platform: "eac", instanceId: "x", sessionId: "s" }).success).toBe(false);
    expect(sessionVersionManifestSchema.safeParse({
      schemaVersion: 1, id: "sv_a", logicalSessionId: "ls_a",
      parents: ["sv_1", "sv_2", "sv_3"], bodyObject: "sha256:a",
      bodyHash: "a", metadataHash: "b", source: {
        platform: "dsh", instanceId: "dsh-web", sessionId: "s", observedAt: "2026-08-26T00:00:00.000Z",
      }, compatibility: { status: "compatible", issues: [] },
    }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the contract test and confirm the exports are missing**

Run: `pnpm vitest run packages/contracts/test/contracts.test.ts`

Expected: FAIL because `platformSessionKeySchema` and `sessionVersionManifestSchema` do not exist.

- [ ] **Step 3: Define the stable domain DTOs**

`model.ts` defines these exact public shapes; all arrays and records exposed across packages are readonly:

```ts
export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type PlatformKind = "codex" | "dsh";
export type SyncMode = "continuation" | "native-mirror" | "paused";
export type CompatibilityStatus = "compatible" | "degraded" | "unsupported";

export interface PlatformSessionKey { readonly platform: PlatformKind; readonly instanceId: string; readonly sessionId: string }
export interface SourceAnchor extends PlatformSessionKey { readonly eventId?: string; readonly sequence: number }
export interface CompatibilityIssue { readonly code: string; readonly message: string; readonly sourceType?: string }
export interface CompatibilityReport { readonly status: CompatibilityStatus; readonly issues: readonly CompatibilityIssue[] }
export interface Provenance extends PlatformSessionKey { readonly observedAt: string; readonly sourceVersion?: string }
export interface AttachmentRef { readonly name: string; readonly mediaType?: string; readonly source: string }

export interface NormalizedEvent {
  readonly id: string;
  readonly parentId: string | null;
  readonly sequence: number;
  readonly kind: "message" | "tool-import" | "attachment" | "metadata";
  readonly role: "user" | "assistant" | "system" | "tool" | "unknown";
  readonly content: string;
  readonly attachments: readonly AttachmentRef[];
  readonly source: SourceAnchor;
  readonly extensions: Readonly<Record<string, JsonValue>>;
}

export interface NormalizedSession {
  readonly schemaVersion: 1;
  readonly key: PlatformSessionKey;
  readonly title: string;
  readonly archived: boolean;
  readonly workspaceId: string | null;
  readonly events: readonly NormalizedEvent[];
  readonly bodyHash: string;
  readonly metadataHash: string;
  readonly provenance: Provenance;
  readonly compatibility: CompatibilityReport;
}

export interface SessionVersionManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly logicalSessionId: string;
  readonly parents: readonly string[];
  readonly bodyObject: string;
  readonly bodyHash: string;
  readonly metadataHash: string;
  readonly source: Provenance;
  readonly compatibility: CompatibilityReport;
}
```

`adapters.ts` fixes the platform boundary. `StableObservation.payload` is `unknown`; only the owning adapter may interpret it:

```ts
export interface RegisteredInstance {
  readonly id: string;
  readonly platform: PlatformKind;
  readonly displayName: string;
  readonly root: string;
  readonly platformVersion: string;
}

export interface AdapterContractRef {
  readonly adapter: string;
  readonly platformVersion: string;
  readonly schemaFingerprint: string;
}

export interface AdapterProbe {
  readonly status: CompatibilityStatus;
  readonly contract: AdapterContractRef;
  readonly capabilities: readonly ("list" | "observe" | "normalize" | "verify-read")[];
  readonly issues: readonly CompatibilityIssue[];
}

export interface ObservationHint {
  readonly size?: number;
  readonly mtimeNs?: string;
  readonly sourceHash?: string;
  readonly eventCount?: number;
}

export interface StateFingerprint {
  readonly platform: PlatformKind;
  readonly instanceId: string;
  readonly sessionId: string;
  readonly kind: "catalog" | "content";
  readonly value: string;
}

export interface PlatformSessionSummary {
  readonly key: PlatformSessionKey;
  readonly title: string;
  readonly archived: boolean;
  readonly workspaceId: string | null;
  readonly updatedAt: string;
  readonly hint: ObservationHint;
}

export interface ScanCursor { readonly opaque: string }
export interface StableObservation { readonly kind: "stable"; readonly key: PlatformSessionKey; readonly fingerprint: StateFingerprint; readonly payload: unknown }
export interface UnstableRead { readonly kind: "unstable"; readonly key: PlatformSessionKey; readonly reason: string; readonly retryable: true }
export interface ExpectedPlatformState { readonly fingerprints: readonly StateFingerprint[] }
export interface VerificationResult { readonly ok: boolean; readonly fingerprints: readonly StateFingerprint[]; readonly issues: readonly CompatibilityIssue[] }

export interface SessionReadAdapter {
  readonly platform: PlatformKind;
  probe(instance: RegisteredInstance): Promise<AdapterProbe>;
  list(instance: RegisteredInstance, cursor?: ScanCursor): AsyncIterable<PlatformSessionSummary>;
  observe(instance: RegisteredInstance, key: PlatformSessionKey, hint?: ObservationHint): Promise<StableObservation | UnstableRead>;
  normalize(observation: StableObservation): Promise<NormalizedSession>;
  verify(instance: RegisteredInstance, key: PlatformSessionKey, expected: ExpectedPlatformState): Promise<VerificationResult>;
}
```

`store.ts` fixes the persistence boundary used by the roadmap rather than letting the SQLite package invent private equivalents:

```ts
export interface LogicalSession {
  readonly id: string;
  readonly displayTitle: string;
  readonly canonicalVersionId: string | null;
  readonly syncMode: SyncMode;
  readonly archived: boolean;
  readonly labels: readonly string[];
  readonly createdAt: string;
}

export interface PlatformBinding {
  readonly id: string;
  readonly logicalSessionId: string;
  readonly key: PlatformSessionKey;
  readonly adapterContract: AdapterContractRef;
  readonly lastCommonVersionId: string | null;
  readonly status: "read-only" | "writable" | "busy" | "incompatible";
}

export interface Checkpoint {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly refs: Readonly<Record<string, string>>;
  readonly backupTransactionIds: readonly string[];
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface NewVersion {
  readonly logicalSessionId: string;
  readonly parents: readonly string[];
  readonly bodyObject: string;
  readonly bodyHash: string;
  readonly metadataHash: string;
  readonly source: Provenance;
  readonly compatibility: CompatibilityReport;
}

export interface ObservedHead {
  readonly bindingId: string;
  readonly versionId: string;
  readonly observedAt: string;
  readonly fingerprint: StateFingerprint;
}

export interface GcPolicy {
  readonly reachableObjectIds: readonly string[];
  readonly olderThan?: string;
  readonly dryRun: boolean;
}

export interface GcReport {
  readonly reachableObjects: number;
  readonly retainedObjects: number;
  readonly deletedObjects: number;
  readonly deletedBytes: number;
}
```

`http.ts` defines `Page<T>`, `SessionQuery`, `SessionSummary` and `VersionGraphPage` in addition to the request/response DTOs used by the CLI client and future Dashboard. The types contain IDs, hashes, states and display metadata only; they never expose a platform root or content-object filesystem path.

- [ ] **Step 4: Define plan, job, HTTP and error contracts**

`plans.ts` fixes the dry-run operation union:

```ts
export type PlannedOperation =
  | { readonly type: "create-target-session"; readonly targetInstanceId: string }
  | { readonly type: "append-events"; readonly fromIndex: number; readonly eventIds: readonly string[] }
  | { readonly type: "update-title"; readonly title: string }
  | { readonly type: "update-archive"; readonly archived: boolean }
  | { readonly type: "deletion-candidate"; readonly missing: PlatformSessionKey }
  | { readonly type: "require-review"; readonly reason: "DIVERGED" | "REWRITTEN" | "METADATA_CONFLICT" | "IDENTITY_CONFLICT" };

export interface SyncPlan {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly hash: string;
  readonly createdAt: string;
  readonly logicalSessionId: string;
  readonly baseVersionId?: string;
  readonly source: BindingSnapshot;
  readonly target?: BindingSnapshot;
  readonly adapterContracts: readonly AdapterContractRef[];
  readonly operations: readonly PlannedOperation[];
  readonly risk: "safe" | "review" | "destructive";
  readonly confirmations: readonly ConfirmationRequirement[];
  readonly preconditions: readonly StateFingerprint[];
}
```

`jobs.ts` fixes `JobRef`, `JobStatus` and the event union `queued | running | progress | completed | failed`. `http.ts` defines paged summaries and request/response DTOs without any `root`, `path`, `cwd` or `home` field. `errors.ts` exports `SessionMaintenanceError` with a typed error code and safe public details.

- [ ] **Step 5: Implement Zod schemas and round-trip tests**

`schemas.ts` validates IDs with `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/`, ISO timestamps with `z.iso.datetime()`, parent count with `.max(2)`, and recursive JSON values. Extend the test to serialize/parse one complete `NormalizedSession`, one `SyncPlan` and each `JobEvent`; assert unknown keys are rejected on HTTP request schemas.

Run:

```powershell
pnpm vitest run packages/contracts/test/contracts.test.ts
pnpm --filter @linmu/dsh-session-contracts typecheck
git diff --check
```

Expected: PASS.

- [ ] **Step 6: Document and commit P2**

The change report records every public type and explicitly states that path-bearing `RegisteredInstance` is Engine-internal and never serialized to browser clients.

```powershell
git add packages/contracts docs/changes/DSH-SESSION-MAINTENANCE-20260826-002.md
git commit -m "feat: define session maintenance contracts"
```

---

### Task P3: Implement canonical normalization and stable hashes

**Files:**
- Create: `packages/session-domain/package.json`
- Create: `packages/session-domain/tsconfig.json`
- Create: `packages/session-domain/src/canonical-json.ts`
- Create: `packages/session-domain/src/normalize.ts`
- Create: `packages/session-domain/src/index.ts`
- Create: `packages/session-domain/test/normalize.test.ts`
- Create: `docs/changes/DSH-SESSION-MAINTENANCE-20260826-003.md`

**Interfaces:**
- Consumes: `NormalizedEvent`, `NormalizedSession`, `PlatformSessionKey`, `CompatibilityReport`, `JsonValue` from contracts.
- Produces: `canonicalJson(value)`, `sha256Canonical(value)`, `normalizeSession(input)`, `NormalizationInput`, `RawSessionEvent`.

- [ ] **Step 1: Write failing stability and metadata-separation tests**

```ts
// packages/session-domain/test/normalize.test.ts
import { describe, expect, it } from "vitest";
import { normalizeSession } from "../src/index.js";

const base = {
  key: { platform: "codex" as const, instanceId: "codex-local", sessionId: "thread-1" },
  title: "First title", archived: false, workspaceId: "workspace:repo-a",
  provenance: { platform: "codex" as const, instanceId: "codex-local", sessionId: "thread-1", observedAt: "2026-08-26T00:00:00.000Z" },
  compatibility: { status: "compatible" as const, issues: [] },
  events: [{ sourceEventId: "u1", parentSourceEventId: null, sequence: 0, kind: "message" as const, role: "user" as const, content: "hello", attachments: [], extensions: {} }],
};

describe("normalizeSession", () => {
  it("excludes observation time and host paths from body identity", () => {
    const first = normalizeSession({ ...base, observedPath: "X:\\portable\\rollout.jsonl" });
    const second = normalizeSession({ ...base, observedPath: "D:\\moved\\rollout.jsonl", provenance: { ...base.provenance, observedAt: "2026-08-27T00:00:00.000Z" } });
    expect(second.bodyHash).toBe(first.bodyHash);
    expect(second.metadataHash).toBe(first.metadataHash);
  });

  it("keeps title changes out of body hash", () => {
    const first = normalizeSession(base);
    const renamed = normalizeSession({ ...base, title: "Renamed" });
    expect(renamed.bodyHash).toBe(first.bodyHash);
    expect(renamed.metadataHash).not.toBe(first.metadataHash);
  });
});
```

- [ ] **Step 2: Run the test and confirm normalization is absent**

Run: `pnpm vitest run packages/session-domain/test/normalize.test.ts`

Expected: FAIL because `normalizeSession` is not exported.

- [ ] **Step 3: Implement deterministic canonical JSON**

`canonical-json.ts` recursively sorts object keys, preserves array order, rejects `undefined`, non-finite numbers and cyclic references, then hashes UTF-8 bytes:

```ts
export function sha256Canonical(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
```

Tests add `{ b: 1, a: 2 }` versus `{ a: 2, b: 1 }`, nested arrays, invalid number and cyclic-object cases.

- [ ] **Step 4: Implement normalized event and session identity**

`normalizeSession()` sorts raw events by `sequence`, rejects duplicate sequence/source IDs, assigns a stable event ID when the source has none, and hashes separate documents:

```ts
const bodyIdentity = {
  schemaVersion: 1,
  events: events.map(({ id, parentId, sequence, kind, role, content, attachments, extensions }) =>
    ({ id, parentId, sequence, kind, role, content, attachments, extensions })),
};
const metadataIdentity = { title: input.title.trim(), archived: input.archived, workspaceId: input.workspaceId };
```

`observedPath`, `provenance.observedAt` and absolute workspace display paths are retained only in observation diagnostics and never enter either identity object. A raw DSH tool event is represented as `kind: "tool-import"`, `role: "tool"`, with `extensions.importedFrom = "DSH"`; it is not renamed to a Codex tool event.

- [ ] **Step 5: Run focused and package tests**

Run:

```powershell
pnpm vitest run packages/session-domain/test/normalize.test.ts
pnpm --filter @linmu/dsh-session-domain typecheck
pnpm test
git diff --check
```

Expected: all tests PASS; changing only timestamps/paths does not create a new hash.

- [ ] **Step 6: Document and commit P3**

```powershell
git add packages/session-domain docs/changes/DSH-SESSION-MAINTENANCE-20260826-003.md pnpm-lock.yaml
git commit -m "feat: normalize sessions with stable hashes"
```

---

### Task P4: Implement version graph and reconciliation classification

**Files:**
- Create: `packages/session-domain/src/graph.ts`
- Create: `packages/session-domain/src/diff.ts`
- Modify: `packages/session-domain/src/index.ts`
- Create: `packages/session-domain/test/graph.test.ts`
- Create: `packages/session-domain/test/diff.test.ts`
- Create: `docs/changes/DSH-SESSION-MAINTENANCE-20260826-004.md`

**Interfaces:**
- Consumes: `NormalizedEvent`, `SessionVersionManifest` and stable hashes from P2–P3.
- Produces: `VersionGraph`, `isAncestor()`, `findMergeBase()`, `classifyHeads()`, `classifyConversationDelta()`, `classifyMetadataDelta()`.

- [ ] **Step 1: Write the failing graph relation tests**

```ts
// packages/session-domain/test/graph.test.ts
import { describe, expect, it } from "vitest";
import { VersionGraph, classifyHeads } from "../src/index.js";

describe("version graph", () => {
  it("distinguishes equal, fast-forward and divergence", () => {
    const graph = new VersionGraph([
      { id: "sv_base", parents: [] },
      { id: "sv_codex", parents: ["sv_base"] },
      { id: "sv_dsh", parents: ["sv_base"] },
    ]);
    expect(classifyHeads(graph, "sv_base", "sv_codex").kind).toBe("target-ahead");
    expect(classifyHeads(graph, "sv_codex", "sv_base").kind).toBe("source-ahead");
    expect(classifyHeads(graph, "sv_codex", "sv_dsh")).toEqual({ kind: "diverged", mergeBase: "sv_base" });
    expect(classifyHeads(graph, "sv_base", "sv_base").kind).toBe("equal");
  });
});
```

- [ ] **Step 2: Write the failing dialogue/metadata decision tests**

```ts
// packages/session-domain/test/diff.test.ts
import { describe, expect, it } from "vitest";
import { classifyConversationDelta, classifyMetadataDelta } from "../src/index.js";

const event = (id: string, content: string) => ({ id, parentId: null, sequence: Number(id.slice(1)), kind: "message" as const, role: "user" as const, content, attachments: [], source: { platform: "dsh" as const, instanceId: "d", sessionId: "s", eventId: id, sequence: Number(id.slice(1)) }, extensions: {} });

it("only calls an exact prefix append-only", () => {
  const base = [event("e0", "a")];
  expect(classifyConversationDelta(base, [...base, event("e1", "b")])).toBe("append-only");
  expect(classifyConversationDelta(base, [event("e0", "changed")])).toBe("rewritten");
});

it("requires review when both sides rename", () => {
  expect(classifyMetadataDelta(
    { title: "base", archived: false },
    { title: "codex", archived: false },
    { title: "dsh", archived: false },
  )).toBe("metadata-conflict");
});
```

- [ ] **Step 3: Run tests and confirm graph/diff exports are absent**

Run: `pnpm vitest run packages/session-domain/test/graph.test.ts packages/session-domain/test/diff.test.ts`

Expected: FAIL on missing exports.

- [ ] **Step 4: Implement DAG validation and ancestor lookup**

`VersionGraph` accepts only nodes whose parent count is `0..2`, rejects duplicate IDs, missing parents and cycles, and exposes immutable node views. `findMergeBase()` walks ancestor distances from both heads and selects the shared ancestor with the smallest combined distance; equal-distance ties use lexical version ID order so results are deterministic.

```ts
export type HeadRelation =
  | { readonly kind: "equal" }
  | { readonly kind: "source-ahead"; readonly mergeBase: string }
  | { readonly kind: "target-ahead"; readonly mergeBase: string }
  | { readonly kind: "diverged"; readonly mergeBase: string }
  | { readonly kind: "unrelated" };
```

`classifyHeads(graph, source, target)` must use ancestry, never timestamps.

- [ ] **Step 5: Implement the decision matrix without automatic dialogue merge**

`classifyConversationDelta(base, next)` returns `unchanged | append-only | rewritten`; append-only requires every base event to be deeply equal at the same index. `classifyMetadataDelta(base, source, target)` returns `unchanged | source-only | target-only | metadata-conflict`. Add tests for deletion, reordered events, one-sided archive and identical two-sided rename.

No function in this task returns a merged transcript. The only output for two-sided dialogue change is `diverged` or `rewritten`.

- [ ] **Step 6: Verify and commit P4**

```powershell
pnpm vitest run packages/session-domain/test/graph.test.ts packages/session-domain/test/diff.test.ts
pnpm --filter @linmu/dsh-session-domain typecheck
git diff --check
git add packages/session-domain docs/changes/DSH-SESSION-MAINTENANCE-20260826-004.md
git commit -m "feat: classify session version relationships"
```

---

### Task P5: Build the SQLite repository and content-addressed Zstd store

**Files:**
- Create: `packages/session-store/package.json`
- Create: `packages/session-store/tsconfig.json`
- Create: `packages/session-store/src/schema.ts`
- Create: `packages/session-store/src/database.ts`
- Create: `packages/session-store/src/object-store.ts`
- Create: `packages/session-store/src/repository.ts`
- Create: `packages/session-store/src/index.ts`
- Create: `packages/session-store/test/object-store.test.ts`
- Create: `packages/session-store/test/repository.test.ts`
- Create: `docs/changes/DSH-SESSION-MAINTENANCE-20260826-005.md`

**Interfaces:**
- Consumes: P2 contracts and P3 canonical serialization.
- Produces: `SqliteSessionRepository`, `ZstdContentObjectStore`, `openMaintenanceDatabase()`, schema version `1`, and the roadmap `SessionRepository`/`ContentObjectStore` methods.

- [ ] **Step 1: Write failing object deduplication and round-trip tests**

```ts
// packages/session-store/test/object-store.test.ts
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ZstdContentObjectStore } from "../src/index.js";

it("deduplicates uncompressed content identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-sm-object-"));
  const store = new ZstdContentObjectStore(root);
  const first = await store.put(Buffer.from("same body"));
  const second = await store.put(Buffer.from("same body"));
  expect(second).toBe(first);
  expect(Buffer.from(await store.get(first)).toString()).toBe("same body");
  expect(await readdir(join(root, "objects", "sha256", first.slice(7, 9)))).toHaveLength(1);
});
```

- [ ] **Step 2: Write failing repository persistence tests**

The repository test creates a logical session, writes a zero-parent version and observed platform ref, closes and reopens SQLite, then asserts the graph, ref and manifest are identical. It also asserts `PRAGMA journal_mode` returns `wal`, duplicate `(platform, instance_id, session_id)` bindings fail, and parent order `0/1` is preserved.

Run: `pnpm vitest run packages/session-store/test`

Expected: FAIL because the store package does not exist.

- [ ] **Step 3: Implement schema migration 001**

`schema.ts` owns the complete version-one schema:

```sql
CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE logical_sessions(id TEXT PRIMARY KEY, display_title TEXT NOT NULL, canonical_version_id TEXT, sync_mode TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, labels_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, FOREIGN KEY(canonical_version_id) REFERENCES session_versions(id));
CREATE TABLE session_versions(id TEXT PRIMARY KEY, logical_session_id TEXT NOT NULL, body_object TEXT NOT NULL, body_hash TEXT NOT NULL, metadata_hash TEXT NOT NULL, source_json TEXT NOT NULL, compatibility_json TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(logical_session_id) REFERENCES logical_sessions(id));
CREATE TABLE version_parents(version_id TEXT NOT NULL, parent_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 1), PRIMARY KEY(version_id, ordinal), FOREIGN KEY(version_id) REFERENCES session_versions(id), FOREIGN KEY(parent_id) REFERENCES session_versions(id));
CREATE TABLE platform_bindings(id TEXT PRIMARY KEY, logical_session_id TEXT NOT NULL, platform TEXT NOT NULL, instance_id TEXT NOT NULL, session_id TEXT NOT NULL, adapter_contract_json TEXT NOT NULL, last_common_version_id TEXT, status TEXT NOT NULL, UNIQUE(platform, instance_id, session_id), FOREIGN KEY(logical_session_id) REFERENCES logical_sessions(id), FOREIGN KEY(last_common_version_id) REFERENCES session_versions(id));
CREATE TABLE platform_refs(binding_id TEXT PRIMARY KEY, observed_version_id TEXT NOT NULL, source_fingerprint_json TEXT NOT NULL, observed_at TEXT NOT NULL, FOREIGN KEY(binding_id) REFERENCES platform_bindings(id), FOREIGN KEY(observed_version_id) REFERENCES session_versions(id));
CREATE TABLE sync_plans(id TEXT PRIMARY KEY, logical_session_id TEXT NOT NULL, plan_hash TEXT NOT NULL, plan_json TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(logical_session_id) REFERENCES logical_sessions(id));
CREATE TABLE scan_cursors(instance_id TEXT PRIMARY KEY, cursor_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE match_candidates(id TEXT PRIMARY KEY, left_binding_id TEXT NOT NULL, right_key_json TEXT NOT NULL, reason TEXT NOT NULL, confidence TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT);
CREATE TABLE checkpoints(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, refs_json TEXT NOT NULL, backup_transaction_ids_json TEXT NOT NULL DEFAULT '[]', created_by TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE jobs(id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, request_json TEXT NOT NULL, result_json TEXT, error_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
```

`openMaintenanceDatabase()` enables `foreign_keys`, requests WAL, sets `busy_timeout = 5000`, runs migrations in `BEGIN IMMEDIATE`, and refuses a database schema newer than the binary.

- [ ] **Step 4: Implement the atomic Zstd object store**

Object identity is `sha256:<hex-of-uncompressed-bytes>`. The path is `objects/sha256/<first-two>/<remaining>.zst`. `put()` compresses with checksum to a same-directory unique temp file opened with `wx`, fsyncs, then renames. If the final object already exists, it removes the temp and verifies decompression/hash before returning the existing ID. `get()` verifies the hash after decompression and throws `OBJECT_CORRUPT` on mismatch.

Use Node built-ins only:

```ts
const compressed = zstdCompressSync(bytes, { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
```

- [ ] **Step 5: Implement repository writes and protected collection**

`putVersion()` writes the body object before opening a SQLite transaction, inserts the immutable manifest and ordered parents, and returns the existing identical manifest on retry. A same ID with different content throws `VERSION_ID_COLLISION`. `recordObservation()` upserts only the platform ref and never updates `logical_sessions.canonical_version_id`.

`SqliteSessionRepository.listReachableObjectIds()` walks every version reachable from platform refs, canonical refs and checkpoints. `collect({ reachableObjectIds, olderThan, dryRun })` deletes only aged object files absent from that exact allowlist; `dryRun: true` returns the same counts without changing disk. The test inserts one orphan object and one referenced object, ages both, calls `collect({ reachableObjectIds: await repository.listReachableObjectIds(), olderThan, dryRun: false })`, and asserts only the orphan is removed.

- [ ] **Step 6: Verify reopen, concurrency and corruption behavior**

Add tests for two concurrent `put()` calls, process reopen, truncated `.zst`, a newer schema version, and retrying the same `putVersion()`. Run:

```powershell
pnpm vitest run packages/session-store/test
pnpm --filter @linmu/dsh-session-store typecheck
git diff --check
```

Expected: all tests PASS with no files outside the temporary root.

- [ ] **Step 7: Document and commit P5**

```powershell
git add packages/session-store docs/changes/DSH-SESSION-MAINTENANCE-20260826-005.md pnpm-lock.yaml
git commit -m "feat: persist immutable session versions"
```

---

### Task P6: Generate immutable dry-run sync plans and reject stale plans

**Files:**
- Create: `packages/session-domain/src/planner.ts`
- Modify: `packages/session-domain/src/index.ts`
- Modify: `packages/session-store/src/repository.ts`
- Create: `packages/session-domain/test/plan-fixtures.ts`
- Create: `packages/session-domain/test/planner.test.ts`
- Create: `packages/session-store/test/plan-store.test.ts`
- Create: `docs/changes/DSH-SESSION-MAINTENANCE-20260826-006.md`

**Interfaces:**
- Consumes: graph/diff classification, `SyncPlan`, `PlannedOperation`, `StateFingerprint`, repository plan persistence.
- Produces: `PlanningService.create(request)`, `PlanningService.validate(plan, currentFingerprints)`, deterministic plan ID/hash and risk assignment.

- [ ] **Step 1: Write failing deterministic-plan tests**

```ts
// packages/session-domain/test/planner.test.ts
import { describe, expect, it } from "vitest";
import { createSyncPlan, validatePlanPreconditions } from "../src/index.js";
import { appendOnlyPlanFixture } from "./plan-fixtures.js";

it("creates a safe append plan with a stable identity", () => {
  const request = appendOnlyPlanFixture({ createdAt: "2026-08-26T00:00:00.000Z" });
  const first = createSyncPlan(request);
  const second = createSyncPlan(request);
  expect(second).toEqual(first);
  expect(first.id).toMatch(/^plan_[0-9a-f]{24}$/);
  expect(first.risk).toBe("safe");
  expect(first.operations.map((item) => item.type)).toEqual(["append-events"]);
});

it("rejects changed target fingerprints", () => {
  const plan = createSyncPlan(appendOnlyPlanFixture({ createdAt: "2026-08-26T00:00:00.000Z" }));
  expect(() => validatePlanPreconditions(plan, [{ ...plan.preconditions[0]!, value: "changed" }])).toThrowError(/PLAN_STALE/);
});
```

`plan-fixtures.ts` exports only `appendOnlyPlanFixture(overrides?)`. It returns one fully populated `PlanRequest` whose source body is a strict prefix of its target candidate, whose adapter contracts and state fingerprints are deterministic, and whose optional overrides are limited to `createdAt`; individual tests clone and change explicit fields for conflict cases.

- [ ] **Step 2: Run tests and verify the planner is missing**

Run: `pnpm vitest run packages/session-domain/test/planner.test.ts packages/session-store/test/plan-store.test.ts`

Expected: FAIL on missing `createSyncPlan` and plan-store methods.

- [ ] **Step 3: Implement operation and risk selection**

The planner maps the decision matrix exactly:

```ts
const riskByOperation: Record<PlannedOperation["type"], SyncPlan["risk"]> = {
  "create-target-session": "safe",
  "append-events": "safe",
  "update-title": "safe",
  "update-archive": "safe",
  "deletion-candidate": "review",
  "require-review": "review",
};
```

Equal heads produce an empty safe plan. Pure prefix produces `append-events`. One-sided allowed metadata produces the matching update. Divergence, rewritten history, dual rename and identity conflict produce only `require-review`; they never contain `append-events` or a synthesized merge.

- [ ] **Step 4: Implement canonical plan identity and stale validation**

Serialize the plan candidate without `id` and `hash`, compute SHA-256, set `hash = sha256:<hex>` and `id = plan_<first-24-hex>`. `createdAt` is supplied by the caller so retries of the same request remain identical. `validatePlanPreconditions()` requires an exact set equality on `{ platform, instanceId, sessionId, kind, value }`; missing, extra or changed fingerprints throw `SessionMaintenanceError("PLAN_STALE", ...)`.

- [ ] **Step 5: Persist and reload exact plan JSON**

`SqliteSessionRepository.savePlan()` validates the plan schema, rejects a same ID/different hash collision, and treats an identical retry as success. `getPlan()` parses through Zod before returning. Add a reopen test and a malformed stored JSON test.

- [ ] **Step 6: Verify and commit P6**

```powershell
pnpm vitest run packages/session-domain/test/planner.test.ts packages/session-store/test/plan-store.test.ts
pnpm test
git diff --check
git add packages/session-domain packages/session-store docs/changes/DSH-SESSION-MAINTENANCE-20260826-006.md
git commit -m "feat: create immutable dry-run sync plans"
```

---

### Task P7: Establish sanitized fixture builders and live-home test guards

**Files:**
- Create: `packages/test-support/package.json`
- Create: `packages/test-support/tsconfig.json`
- Create: `packages/test-support/src/sandbox.ts`
- Create: `packages/test-support/src/codex-fixture.ts`
- Create: `packages/test-support/src/dsh-fixture.ts`
- Create: `packages/test-support/src/index.ts`
- Create: `packages/test-support/test/sandbox.test.ts`
- Create: `fixtures/codex/0.146.0/manifest.yaml`
- Create: `fixtures/codex/0.146.0/rollout.jsonl`
- Create: `fixtures/dsh/0.1.1-rc.2/manifest.yaml`
- Create: `fixtures/dsh/0.1.1-rc.2/header.json`
- Create: `fixtures/dsh/0.1.1-rc.2/events.jsonl`
- Create: `docs/changes/DSH-SESSION-MAINTENANCE-20260826-007.md`

**Interfaces:**
- Consumes: Node temp/filesystem/sqlite/zlib APIs and P2 error codes.
- Produces: `createFixtureSandbox()`, `assertFixtureSandbox()`, `writeCodexFixtureHome()`, `writeDshFixtureHome()`, marker `.dsh-session-maintenance-fixture`.

- [ ] **Step 1: Write the failing live-home rejection test**

```ts
// packages/test-support/test/sandbox.test.ts
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { assertFixtureSandbox, createFixtureSandbox } from "../src/index.js";

it("rejects an unmarked real-looking home", async () => {
  expect(() => assertFixtureSandbox(join(homedir(), ".codex"))).toThrowError(/LIVE_HOME_FORBIDDEN/);
  const sandbox = await createFixtureSandbox("guard");
  expect(() => assertFixtureSandbox(sandbox.root)).not.toThrow();
});
```

- [ ] **Step 2: Run and confirm the guard is absent**

Run: `pnpm vitest run packages/test-support/test/sandbox.test.ts`

Expected: FAIL on missing exports.

- [ ] **Step 3: Implement the process-level fixture guard**

`createFixtureSandbox(name)` creates a unique directory below `os.tmpdir()`, writes the marker containing a random UUID, and returns `{ root, codexHome, dshHome, cleanup }`. `assertFixtureSandbox(root)` resolves symlinks, requires containment below the system temp directory and requires the marker to be a regular file. Under `VITEST=true`, every adapter constructor calls this guard before opening a root.

The guard must reject `join(homedir(), ".codex")`, `D:\non-fixture\dsh`, a symlink escaping the sandbox, the temp root itself and a directory whose marker is a symlink.

- [ ] **Step 4: Add human-readable sanitized fixture sources**

The Codex source fixture contains one synthetic UUID, one `session_meta`, one user message and one assistant message. The DSH source fixture contains a synthetic session header plus `user/message`, `assistant/message`, `tool/call` and `tool/result`. Names, paths and message text use `C:\fixture\workspace` and non-secret lorem text; no live IDs or content are copied.

Each manifest records:

```yaml
schemaVersion: 1
platformVersion: 0.146.0
synthetic: true
containsUserData: false
```

The DSH manifest uses `platformVersion: 0.1.1-rc.2`.

- [ ] **Step 5: Implement fixture home materialization**

`writeCodexFixtureHome()` creates `state_5.sqlite` with the exact `threads` columns used by the read adapter, writes `session_index.jsonl`, and places the rollout below `sessions/2026/08/26/`. `writeDshFixtureHome()` Zstd-compresses header and event JSONL into two frames at `sessions/<project>/<uuid>/session.jsonl.zstd`, and writes a minimal `storages/workspace.json` and `storages/session_projcache.json`.

Both helpers first call `assertFixtureSandbox()` and refuse an existing non-empty destination unless it already carries the same marker.

- [ ] **Step 6: Verify fixtures are deterministic and contain no machine data**

Run:

```powershell
pnpm vitest run packages/test-support/test/sandbox.test.ts
$localUserPattern = [regex]::Escape([Environment]::UserName)
rg -n "$localUserPattern|OneDrive|AppData|DeepSeek-Harness|api[_-]?key|Bearer " fixtures packages/test-support
git diff --check
```

Expected: tests PASS and `rg` returns no matches.

- [ ] **Step 7: Document and commit P7**

```powershell
git add packages/test-support fixtures docs/changes/DSH-SESSION-MAINTENANCE-20260826-007.md pnpm-lock.yaml
git commit -m "test: add isolated session fixtures"
```

---

### Task P8: Implement the Codex 0.146.0 read adapter

**Files:**
- Create: `packages/adapter-codex-read/package.json`
- Create: `packages/adapter-codex-read/tsconfig.json`
- Create: `packages/adapter-codex-read/src/probe.ts`
- Create: `packages/adapter-codex-read/src/catalog.ts`
- Create: `packages/adapter-codex-read/src/stable-read.ts`
- Create: `packages/adapter-codex-read/src/parser.ts`
- Create: `packages/adapter-codex-read/src/normalizer.ts`
- Create: `packages/adapter-codex-read/src/index.ts`
- Create: `packages/adapter-codex-read/test/codex-adapter.test.ts`
- Create: `packages/adapter-codex-read/test/codex-schema.test.ts`
- Create: `docs/changes/DSH-SESSION-MAINTENANCE-20260826-008.md`

**Interfaces:**
- Consumes: `SessionReadAdapter`, P3 normalization, fixture sandbox and synthetic Codex home.
- Produces: `CodexReadAdapter`, contract ID `codex-read/0.146.0/schema-1`, stable summaries, normalized Codex sessions and read-only incompatibility diagnostics.

- [ ] **Step 1: Write failing list/observe/normalize tests**

```ts
// packages/adapter-codex-read/test/codex-adapter.test.ts
import { expect, it } from "vitest";
import { createFixtureSandbox, writeCodexFixtureHome } from "@linmu/dsh-session-test-support";
import { CodexReadAdapter } from "../src/index.js";

it("lists and normalizes a persisted Codex thread", async () => {
  const sandbox = await createFixtureSandbox("codex-read");
  await writeCodexFixtureHome(sandbox.codexHome);
  const adapter = new CodexReadAdapter();
  const instance = { id: "codex-fixture", platform: "codex" as const, root: sandbox.codexHome, displayName: "fixture", platformVersion: "0.146.0" };
  const probe = await adapter.probe(instance);
  expect(probe.status).toBe("compatible");
  const summaries = [];
  for await (const summary of adapter.list(instance)) summaries.push(summary);
  expect(summaries).toHaveLength(1);
  const observed = await adapter.observe(instance, summaries[0]!.key);
  expect(observed.kind).toBe("stable");
  if (observed.kind !== "stable") throw new Error("fixture unexpectedly unstable");
  const normalized = await adapter.normalize(observed);
  expect(normalized.events.map((event) => event.role)).toEqual(["user", "assistant"]);
});
```

- [ ] **Step 2: Run tests and confirm the adapter is missing**

Run: `pnpm vitest run packages/adapter-codex-read/test`

Expected: FAIL because `CodexReadAdapter` does not exist.

- [ ] **Step 3: Implement the version/schema probe**

`probe.ts` opens `state_5.sqlite` read-only, verifies table `threads` contains at least `id`, `rollout_path`, `title`, `name`, `cwd`, `created_at`, `updated_at`, `archived`, and inspects the first synthetic rollout for the `session_meta`/`response_item` envelope. It hashes sorted table/column names plus supported event envelope names into the adapter schema fingerprint.

For the known fixture it returns:

```ts
{
  status: "compatible",
  contract: { adapter: "codex-read", platformVersion: "0.146.0", schemaFingerprint },
  capabilities: ["list", "observe", "normalize", "verify-read"],
  issues: [],
}
```

Missing optional `sqlite/codex-dev.db` or `session_index.jsonl` yields `degraded`; a changed `threads` shape or unknown rollout envelope yields `unsupported`. Unsupported probes never attempt writes and remain available as diagnostics.

- [ ] **Step 4: Implement metadata-first catalog listing**

`catalog.ts` reads thread rows from `state_5.sqlite`, resolves the title in this order: non-missing `local_thread_catalog.display_title`, `session_index.jsonl.thread_name`, `threads.name`, `threads.title`, first user text. It includes archived rows with `archived: true` and skips approval-review transcripts whose first user text starts with either known approval-assessment prefix.

`list()` returns `PlatformSessionSummary` using database metadata and file `size/mtimeNs`; it must not read the full rollout body when a valid summary is available. A counter-injected filesystem test asserts listing 100 summaries calls `readFile` zero times.

- [ ] **Step 5: Implement stable rollout observation**

`stable-read.ts` compares bigint `size` and `mtimeNs` before and after reading, up to three attempts. It returns:

```ts
{ kind: "unstable", key, code: "UNSTABLE_READ", attempts: 3 }
```

instead of throwing after three changing reads. A missing file returns a typed `SOURCE_MISSING` observation error. `observe()` computes SHA-256 only after a stable read and includes `size`, `mtimeNs`, `sha256` in its fingerprint.

- [ ] **Step 6: Parse and normalize supported Codex events**

`parser.ts` parses JSONL line-by-line and requires exactly one matching `session_meta` thread ID. It maps user/assistant `response_item` message content to raw message events, preserves supported attachment references, and records other `event_msg`, tool and lifecycle envelopes as source extensions without inventing visible dialogue. Malformed JSON reports line number and prevents a version from being recorded.

`normalizer.ts` calls P3 `normalizeSession()`, uses stable source event IDs when present, and emits a compatibility issue for each preserved unknown event type. Private reasoning content is neither inferred nor copied from UI text.

- [ ] **Step 7: Add unknown-schema and unstable-read contract tests**

Tests mutate a copied fixture to remove a required `threads` column, add an unknown event envelope, truncate JSONL, and inject changing stats. Assert respectively: `unsupported`, `degraded` with source type, parse failure with line, and `UNSTABLE_READ` with no normalized session.

Run:

```powershell
pnpm vitest run packages/adapter-codex-read/test
pnpm --filter @linmu/dsh-adapter-codex-read typecheck
git diff --check
```

- [ ] **Step 8: Document and commit P8**

```powershell
git add packages/adapter-codex-read docs/changes/DSH-SESSION-MAINTENANCE-20260826-008.md pnpm-lock.yaml
git commit -m "feat: scan Codex sessions read-only"
```

---

### Task P9: Implement the official DSH 0.1.1-rc.2 read adapter

**Files:**
- Create: `packages/adapter-dsh/package.json`
- Create: `packages/adapter-dsh/tsconfig.json`
- Create: `packages/adapter-dsh/src/probe.ts`
- Create: `packages/adapter-dsh/src/zstd-codec.ts`
- Create: `packages/adapter-dsh/src/reader.ts`
- Create: `packages/adapter-dsh/src/normalizer.ts`
- Create: `packages/adapter-dsh/src/index.ts`
- Create: `packages/adapter-dsh/test/dsh-adapter.test.ts`
- Create: `packages/adapter-dsh/test/zstd-codec.test.ts`
- Create: `docs/changes/DSH-SESSION-MAINTENANCE-20260826-009.md`

**Interfaces:**
- Consumes: `SessionReadAdapter`, P3 normalization, fixture sandbox and synthetic DSH home.
- Produces: `DshReadAdapter`, contract ID `dsh-read/0.1.1-rc.2/session-v0`, bounded Zstd multi-frame decoder and normalized DSH source anchors.

- [ ] **Step 1: Write failing multi-frame and adapter tests**

```ts
// packages/adapter-dsh/test/zstd-codec.test.ts
import { expect, it } from "vitest";
import { encodeFixtureArtifact, decodeDshArtifact } from "../src/index.js";

it("decodes a header frame and event frame without concatenation loss", () => {
  const bytes = encodeFixtureArtifact({ type: "session", version: 0, id: "dsh-session-1", createdAt: 1, cwd: "C:\\fixture\\workspace", delegationDepth: 0 }, [
    { type: "user/message", seq: 0, time: 1, data: { content: [{ type: "text", text: "hello" }] } },
  ]);
  const decoded = decodeDshArtifact(bytes);
  expect(decoded.frameCount).toBe(2);
  expect(decoded.header.id).toBe("dsh-session-1");
  expect(decoded.events).toHaveLength(1);
});
```

The adapter test materializes the fixture, lists one session, observes it, normalizes four events, and asserts tool call/result become `tool-import` with `extensions.importedFrom === "DSH"`.

- [ ] **Step 2: Run tests and confirm DSH exports are absent**

Run: `pnpm vitest run packages/adapter-dsh/test`

Expected: FAIL on missing adapter and codec exports.

- [ ] **Step 3: Implement a bounded Zstd frame codec**

`zstd-codec.ts` validates Zstd magic `0xFD2FB528`, frame headers, reserved bits, block sizes and checksum boundaries before calling `zstdDecompressSync`. Limits are fixed at 64 MiB compressed artifact, 256 MiB decompressed bytes, 1,000,000 JSONL lines and 8 MiB per line. Truncated frame, invalid block type, invalid session header and limit overflow return typed errors.

`decodeHeaderFrame()` decompresses only the first frame for summary scans. `decodeDshArtifact()` reads all frames for `observe()`. `encodeFixtureArtifact()` is exported only from the package test export path and is not used by production writes.

- [ ] **Step 4: Probe and list official DSH sessions metadata-first**

`probe.ts` verifies the registered DSH instance declares `platformVersion: "0.1.1-rc.2"`, that `sessions/` and `storages/` are contained below the registered root, and that sampled headers are `type: "session", version: 0`. Unknown header version makes the adapter `unsupported`.

`reader.ts` enumerates only `sessions/<project>/<session>/session.jsonl.zstd`, decodes the header frame, and joins archived IDs from `storages/workspace.json`. It rejects symlinks escaping the registered root. Duplicate header IDs produce two read-only `IDENTITY_CONFLICT` diagnostics and no automatic binding candidate.

- [ ] **Step 5: Normalize DSH dialogue without forging Codex tools**

Map `user/message` and visible assistant message events to `kind: "message"`; preserve `session/title` as metadata; combine each DSH tool call/result into ordered `tool-import` records whose source anchor keeps the DSH `seq` and raw event type. Unknown DSH event types remain extensions and add a degraded compatibility issue. Runtime seed/preset/sandbox/approval tail events remain source metadata rather than visible dialogue.

The normalized workspace identity is a hash of the normalized registered workspace mapping, not the raw `cwd` string; the raw path stays in adapter diagnostics only.

- [ ] **Step 6: Add corruption, escape and lazy-read tests**

Test invalid magic, truncated second frame, oversized declared block, path escape symlink, duplicate IDs and unknown session version. Instrument reads so listing 100 sessions decompresses 100 header frames but zero event frames; observing one session decompresses only that session fully.

Run:

```powershell
pnpm vitest run packages/adapter-dsh/test
pnpm --filter @linmu/dsh-adapter-dsh typecheck
git diff --check
```

- [ ] **Step 7: Document and commit P9**

```powershell
git add packages/adapter-dsh docs/changes/DSH-SESSION-MAINTENANCE-20260826-009.md pnpm-lock.yaml
git commit -m "feat: scan official DSH sessions read-only"
```

---

### Task P10: Implement clean discovery, idempotent binding and match candidates

**Files:**
- Create: `packages/session-domain/src/discovery.ts`
- Modify: `packages/session-domain/src/index.ts`
- Modify: `packages/session-store/src/repository.ts`
- Create: `packages/session-domain/test/discovery.test.ts`
- Create: `tests/integration/helpers/read-only-system.ts`
- Create: `tests/integration/discovery-idempotence.test.ts`
- Create: `tests/integration/discovery-conflicts.test.ts`
- Create: `docs/changes/DSH-SESSION-MAINTENANCE-20260826-010.md`

**Interfaces:**
- Consumes: read adapters, immutable store, graph classification and explicit provenance.
- Produces: `DiscoveryService.scanInstance()`, `DiscoveryResult`, deterministic LogicalSession/SessionVersion IDs, unresolved `MatchCandidate` records and observed refs.

- [ ] **Step 1: Write failing two-scan idempotence test**

```ts
// tests/integration/discovery-idempotence.test.ts
it("records the same fixture state once across repeated scans", async () => {
  const system = await createReadOnlyTestSystem();
  const first = await system.discovery.scanAll();
  const firstCounts = await system.repository.counts();
  const second = await system.discovery.scanAll();
  expect(second.createdVersions).toBe(0);
  expect(second.createdBindings).toBe(0);
  expect(await system.repository.counts()).toEqual(firstCounts);
  expect(first.platformWrites).toBe(0);
  expect(second.platformWrites).toBe(0);
});
```

`tests/integration/helpers/read-only-system.ts` exports `createReadOnlyTestSystem()`. It creates one marked fixture sandbox, materializes both platform homes, opens a temporary object store/repository, registers the two read adapters and returns `{ sandbox, repository, discovery, platformRoots, cleanup }`. The helper has no default path and cannot accept a caller-provided live root.

- [ ] **Step 2: Write failing identity-policy tests**

Add cases proving:

- explicit `sourceSessionId` provenance plus compatible prefix auto-binds Codex and DSH;
- same title without provenance creates two logical sessions and one low-confidence candidate;
- same UUID with unrelated bodies creates `IDENTITY_CONFLICT` and does not bind;
- an unstable observation creates no version/ref;
- a single-platform session is still a valid LogicalSession with `canonical_version_id = null`.

Run: `pnpm vitest run packages/session-domain/test/discovery.test.ts tests/integration/discovery-*.test.ts`

Expected: FAIL because the discovery service and repository methods are missing.

- [ ] **Step 3: Implement deterministic observation IDs**

Use these identities:

```ts
logicalSessionId = `ls_${sha256Canonical({ platform, instanceId, sessionId }).slice(0, 24)}`;
versionId = `sv_${sha256Canonical({ logicalSessionId, parents, bodyHash, metadataHash }).slice(0, 24)}`;
bindingId = `binding_${sha256Canonical(key).slice(0, 24)}`;
candidateId = `match_${sha256Canonical({ leftBindingId, rightKey, reason }).slice(0, 24)}`;
```

The first observed version has zero parents. A changed observation uses the previous observed version as its single parent. Retrying the same normalized content reuses the existing version and only refreshes scan metadata; it does not create a new version from a later `observedAt`.

- [ ] **Step 4: Implement the matching confidence policy**

Matching priority is fixed:

1. explicit cross-platform provenance/source UUID plus equal or prefix-compatible body: auto-bind;
2. an existing binding with the same exact platform key: update that observed ref;
3. equal normalized root/prefix identity plus equal stable workspace ID: create a `high` candidate requiring confirmation;
4. equal title only: create a `low` candidate and never auto-bind;
5. reused UUID with unrelated body: create an `IDENTITY_CONFLICT` candidate and block planning between those bindings.

`scanInstance()` persists an observed version/ref only after stable normalization succeeds. It never sets or changes canonical ref and never calls an adapter write method.

- [ ] **Step 5: Implement repository methods transactionally**

Add `createLogicalSession()`, `findBinding()`, `bindPlatformSession()`, `upsertMatchCandidate()`, `listMatchCandidates()`, `counts()` and `recordObservedVersion()`. `recordObservedVersion()` wraps logical session/version/parent/binding/ref changes in one SQLite transaction after the body object exists; a retry returns counters with zero creates.

- [ ] **Step 6: Prove no platform bytes change**

The integration test hashes every file below both fixture homes before and after two scans and compares the full relative-path/hash map. It also asserts the repository canonical refs remain null and all platform refs point at valid version nodes.

Run:

```powershell
pnpm vitest run packages/session-domain/test/discovery.test.ts tests/integration/discovery-idempotence.test.ts tests/integration/discovery-conflicts.test.ts
pnpm test
git diff --check
```

- [ ] **Step 7: Document and commit P10**

```powershell
git add packages/session-domain packages/session-store tests/integration docs/changes/DSH-SESSION-MAINTENANCE-20260826-010.md
git commit -m "feat: discover session versions idempotently"
```

---

### Task P11: Expose read-only Engine composition and CLI workflows

**Files:**
- Create: `apps/engine/package.json`
- Create: `apps/engine/tsconfig.json`
- Create: `apps/engine/src/config.ts`
- Create: `apps/engine/src/composition-root.ts`
- Create: `apps/engine/src/engine.ts`
- Create: `apps/engine/src/cli.ts`
- Create: `apps/engine/src/main.ts`
- Create: `apps/engine/test/helpers.ts`
- Create: `apps/engine/test/config.test.ts`
- Create: `apps/engine/test/cli.test.ts`
- Create: `docs/changes/DSH-SESSION-MAINTENANCE-20260826-011.md`

**Interfaces:**
- Consumes: repository, object store, discovery service, planner, Codex/DSH read adapters.
- Produces: binary `dsh-session-maint`, internal `ReadOnlyEngine`, commands `init`, `instance add/list`, `scan`, `diff`, `plan`, `status`; `apply`/`restore` return `CAPABILITY_NOT_AVAILABLE`.

- [ ] **Step 1: Write failing CLI contract tests**

```ts
// apps/engine/test/cli.test.ts
it("initializes, registers fixtures and scans without platform writes", async () => {
  const fixture = await createFixtureSystem("cli");
  const before = await hashTree(fixture.platformRoot);
  await runCli(["--state-root", fixture.stateRoot, "init", "--json"]);
  await runCli(["--state-root", fixture.stateRoot, "instance", "add", "--id", "codex-fixture", "--platform", "codex", "--root", fixture.codexHome, "--platform-version", "0.146.0", "--json"]);
  const result = await runCli(["--state-root", fixture.stateRoot, "scan", "--instance", "codex-fixture", "--json"]);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout).createdVersions).toBe(1);
  expect(await hashTree(fixture.platformRoot)).toEqual(before);
});
```

Add a test that `apply --plan plan_x` exits `2` with JSON error code `CAPABILITY_NOT_AVAILABLE` and creates no transaction directory.

- [ ] **Step 2: Run tests and confirm the Engine app is absent**

Run: `pnpm vitest run apps/engine/test`

Expected: FAIL because the CLI package does not exist.

- [ ] **Step 3: Implement validated YAML configuration**

`config.yaml` is Engine-private and has this exact shape:

```yaml
schemaVersion: 1
instances:
  codex-local:
    platform: codex
    displayName: Local Codex
    root: C:\Users\name\.codex
    platformVersion: 0.146.0
```

Only trusted CLI command `instance add` accepts `--root`; it resolves and stores the path after the matching adapter probe succeeds. HTTP DTOs never reuse this schema. Config writes use same-directory temp + fsync + rename and preserve unknown future top-level keys only when the schema version is still `1`.

- [ ] **Step 4: Build one composition root**

`createReadOnlyComposition({ stateRoot })` opens `<stateRoot>/metadata.sqlite`, `<stateRoot>/objects`, reads config, registers exactly one adapter per platform, and returns:

```ts
export interface ReadOnlyEngine {
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

No command constructs adapters or opens SQLite independently. Tests inject a clock, filesystem and fixture access policy through composition options. `apps/engine/test/helpers.ts` exports `createFixtureSystem(name)`, `runCli(argv, fixture)`, and `hashTree(root)`: it builds only marked temporary Codex/DSH homes, invokes the CLI in-process with captured streams, and hashes relative file paths plus bytes so every CLI test can prove platform immutability.

- [ ] **Step 5: Implement the CLI command surface**

Use Commander `14.0.0` with global `--state-root <path>` and `--json`. Commands are:

```text
dsh-session-maint init
dsh-session-maint instance add --id <id> --platform codex|dsh --root <path> --platform-version <version>
dsh-session-maint instance list
dsh-session-maint scan (--instance <id> | --all)
dsh-session-maint diff --logical-session <id> [--source <binding-id>] [--target <binding-id>]
dsh-session-maint plan --logical-session <id> --source <binding-id> [--target <binding-id>]
dsh-session-maint status
dsh-session-maint apply --plan <id>
dsh-session-maint restore --transaction <id>
```

`apply` and `restore` are present to stabilize the interface but return `CAPABILITY_NOT_AVAILABLE` in phase one. JSON mode writes exactly one JSON object to stdout; diagnostics go to stderr and never contain capability tokens or conversation bodies.

- [ ] **Step 6: Add CLI path and read-only regression tests**

Test invalid platform version, duplicate instance ID, a root that does not match its platform, missing instance, unknown logical session, repeated scan and unsupported apply/restore. Hash both fixture homes around every command that touches an adapter.

Run:

```powershell
pnpm vitest run apps/engine/test
pnpm --filter @linmu/dsh-session-engine typecheck
pnpm test
git diff --check
```

- [ ] **Step 7: Document and commit P11**

```powershell
git add apps/engine docs/changes/DSH-SESSION-MAINTENANCE-20260826-011.md pnpm-lock.yaml
git commit -m "feat: expose read-only session maintenance CLI"
```

---

### Task P12: Add the loopback API, persistent job queue and typed client

**Files:**
- Create: `apps/engine/src/jobs/job-runner.ts`
- Create: `apps/engine/src/jobs/job-store.ts`
- Create: `apps/engine/src/http/auth.ts`
- Create: `apps/engine/src/http/body.ts`
- Create: `apps/engine/src/http/routes.ts`
- Create: `apps/engine/src/http/server.ts`
- Create: `apps/engine/src/http/sse.ts`
- Modify: `apps/engine/src/engine.ts`
- Modify: `apps/engine/src/cli.ts`
- Create: `packages/session-store/src/migrations/002-job-events.ts`
- Create: `packages/local-api-client/package.json`
- Create: `packages/local-api-client/tsconfig.json`
- Create: `packages/local-api-client/src/client.ts`
- Create: `packages/local-api-client/src/event-stream.ts`
- Create: `packages/local-api-client/src/index.ts`
- Create: `apps/engine/test/http-api.test.ts`
- Create: `apps/engine/test/job-runner.test.ts`
- Modify: `apps/engine/test/helpers.ts`
- Create: `packages/local-api-client/test/client.test.ts`
- Create: `docs/changes/DSH-SESSION-MAINTENANCE-20260826-012.md`

**Interfaces:**
- Consumes: `ReadOnlyEngine`, P2 HTTP/job DTOs and Engine-private registered instances.
- Produces: roadmap `SessionMaintenanceEngine` read-only implementation, `MaintenanceClient`, connection file, authenticated HTTP/SSE contract and resumable read-only scan jobs.

- [ ] **Step 1: Write failing loopback/auth tests**

```ts
// apps/engine/test/http-api.test.ts
it("binds only loopback and requires the capability token", async () => {
  const fixture = await createEngineFixture("http");
  const server = await fixture.startServer({ host: "127.0.0.1", port: 0 });
  expect(server.address.host).toBe("127.0.0.1");
  expect((await fetch(`${server.origin}/v1/sessions`)).status).toBe(401);
  expect((await fetch(`${server.origin}/v1/sessions`, { headers: { authorization: `Bearer ${server.token}` } })).status).toBe(200);
  await expect(fixture.startServer({ host: "0.0.0.0", port: 0 })).rejects.toThrow(/LOOPBACK_ONLY/);
});
```

Extend `apps/engine/test/helpers.ts` with `createEngineFixture(name)`. It composes the real phase-one Engine over a marked fixture state root and returns `{ engine, stateRoot, startServer, stop, cleanup }`; `startServer()` always defaults to port `0`, exposes the generated token only to the test process, and rejects a non-loopback host before opening a socket.

Add tests for a malicious `Origin`, body larger than 64 KiB, an HTTP request containing `root`, and `POST /v1/plans/:id/apply` returning `409 CAPABILITY_NOT_AVAILABLE`.

- [ ] **Step 2: Write failing persistent job/SSE tests**

Submit a scan job, subscribe from event sequence zero, assert `queued → running → progress → completed`, restart the Engine with a queued fixture job, and assert it resumes exactly once. A running read-only scan interrupted by restart is safely requeued because P10 scan is idempotent.

Run: `pnpm vitest run apps/engine/test/http-api.test.ts apps/engine/test/job-runner.test.ts`

Expected: FAIL because HTTP and jobs are missing.

- [ ] **Step 3: Add migration 002 and the persistent job runner**

Migration 002 creates:

```sql
CREATE TABLE job_events(job_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(job_id, sequence));
CREATE INDEX job_events_created_idx ON job_events(created_at);
```

`JobRunner.enqueue(kind, request)` inserts `queued`; a single worker transitions through states in SQLite transactions and appends monotonically numbered events. On startup, phase-one `scan` jobs in `queued` or `running` return to `queued`; unknown/non-idempotent job kinds become `failed` with `RECOVERY_REQUIRED`.

- [ ] **Step 4: Implement private connection credentials**

`auth.ts` generates 32 random bytes and writes `<stateRoot>/connection.json` with `{ schemaVersion: 1, host: "127.0.0.1", port, token }`. Open with mode `0o600`; on Windows, call `whoami.exe` and then:

```ts
await execFile("icacls.exe", [connectionPath, "/inheritance:r", "/grant:r", `${account}:F`]);
```

Command arguments are an array and never pass through a shell. The token is redacted from logs and error JSON. Tests inject a fake ACL runner and assert the exact argument vector; a Windows-only integration test verifies inherited broad access is absent.

- [ ] **Step 5: Implement the bounded HTTP/SSE surface**

The Node HTTP server rejects any host other than `127.0.0.1`, applies `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and a restrictive CSP. Bearer auth is required for every `/v1/*` route except `/v1/health`. An `Origin` header, when present, must equal the server origin.

Routes:

```text
GET  /v1/health
GET  /v1/instances
GET  /v1/sessions?cursor=&limit=&platform=&status=
GET  /v1/sessions/:id/graph?cursor=&limit=
POST /v1/diffs                     DiffRequest
POST /v1/jobs/scan                 { instanceIds: string[] }
GET  /v1/jobs/:id
GET  /v1/jobs/:id/events           text/event-stream
POST /v1/plans                     PlanRequest
GET  /v1/plans/:id
POST /v1/plans/:id/apply           phase-one 409
POST /v1/transactions/:id/restore  phase-one 409
```

All route bodies use P2 strict schemas and a 64 KiB maximum. Pagination defaults to 50 and caps at 200. The server resolves instance roots from config only.

- [ ] **Step 6: Implement the typed local API client**

`MaintenanceClient` accepts `{ origin, token, fetchImpl? }`, serializes only P2 DTOs, parses every response through Zod and converts SSE lines into the `JobEvent` union. It throws `SessionMaintenanceError` using the server code/status and never includes the bearer token in its message.

Client tests use the real temporary server and cover pagination, graph pagination, `getDiff()`, plan lookup, scan events, stale plan error, malformed server JSON and aborting an event subscription.

- [ ] **Step 7: Verify API security and commit P12**

Run:

```powershell
pnpm vitest run apps/engine/test/http-api.test.ts apps/engine/test/job-runner.test.ts packages/local-api-client/test/client.test.ts
pnpm test
pnpm typecheck
git diff --check
```

Expected: all tests PASS; platform fixture hashes remain unchanged; logs contain neither the token nor message bodies.

```powershell
git add apps/engine packages/session-store packages/local-api-client docs/changes/DSH-SESSION-MAINTENANCE-20260826-012.md pnpm-lock.yaml
git commit -m "feat: serve read-only maintenance jobs locally"
```

---

### Task P13: Complete phase-one acceptance, portability checks and documentation

**Files:**
- Create: `scripts/assert-portable.mjs`
- Create: `tests/contract/portable-package.test.ts`
- Create: `tests/integration/phase-1-acceptance.test.ts`
- Create: `tests/integration/phase-1-large-catalog.test.ts`
- Create: `README.md`
- Create: `docs/validation/phase-1-validation.md`
- Create: `docs/changes/DSH-SESSION-MAINTENANCE-20260826-013.md`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: all P1–P12 deliverables.
- Produces: reproducible phase-one release candidate, `pnpm test:phase1`, `pnpm assert:portable`, clean-clone proof and a signed-off gate before any DSH write work.

- [ ] **Step 1: Write the failing end-to-end acceptance matrix**

`phase-1-acceptance.test.ts` constructs synthetic Codex/DSH homes and verifies these scenarios in one isolated state root:

```ts
const expected = {
  unchanged: "skip",
  sourcePrefixGrowth: "append-events",
  targetPrefixGrowth: "append-events",
  dualAppend: "DIVERGED",
  rewrittenHistory: "REWRITTEN",
  oneSidedRename: "update-title",
  dualRename: "METADATA_CONFLICT",
  archivedMirrorMetadata: "update-archive",
  missingPreviouslyObservedSession: "deletion-candidate",
  reusedUuidWithUnrelatedBody: "IDENTITY_CONFLICT",
};
```

For every scenario it hashes platform trees before/after, performs two scans, verifies zero duplicate records on the second scan, creates a plan and compares its operation/reason with the table.

- [ ] **Step 2: Write the failing lazy-catalog performance contract**

Create 1,000 synthetic summaries backed by a counting read adapter. First scan may observe each new body once; the second unchanged scan must call full `observe()` zero times, create zero versions and complete with bounded adapter concurrency `<= 4`. Fetching the first API page must read zero body objects; fetching one graph page may read only the selected logical session's manifests.

Run: `pnpm vitest run tests/integration/phase-1-*.test.ts`

Expected: FAIL until orchestration exposes counters/pagination needed by the acceptance tests.

- [ ] **Step 3: Close only the measured acceptance gaps**

Add counters and query pagination through existing repository/Engine interfaces; do not create a second scan path. Cache only lightweight `{ size, mtimeNs, sourceHash, eventCount }` cursor data. Use a four-worker read pool for changed sessions and a single SQLite write queue. No file watcher, Dashboard, DSH writer or Codex creator is added in this task.

- [ ] **Step 4: Implement portability and legacy-runtime checks**

`assert-portable.mjs` scans runtime manifests and compiled output under `apps/` and `packages/`, plus the materialized synthetic fixtures, and fails on:

- absolute paths containing drive roots or `C:\Users`;
- runtime dependency specifiers beginning `file:` or `link:`;
- `workspace:` specifiers outside the allowlisted internal packages named in **Workspace package contract**, or any source/path specifier left in compiled `dist/` imports;
- imports/spawns mentioning `dsh-codex-session-sync`, `sync.mjs`, `sync-and-restart.ps1`, `/codex-sync` or `EAC`;
- fixture data containing the current account name or a credential-shaped value seeded by the portability test.

Documentation, planning files and tests are excluded from runtime path/legacy checks because they intentionally name migration sources and forbidden examples. A separate repository-wide credential test scans tracked text against injected canary secrets and high-confidence credential assignments; documentation is not excluded from that credential test. Phase one intentionally keeps internal manifests on `workspace:*`; installable tgz dependency rewriting and unpacked-artifact verification enter the phase-two packaging gate, not this source-only portability check.

- [ ] **Step 5: Add phase-one user/developer documentation**

README explains that this release is read-only, lists supported fixture contracts (`Codex 0.146.0`, `DSH 0.1.1-rc.2`), gives exact commands to initialize a state root, register instances, scan, inspect diff and create a dry-run plan, and states that `apply`/`restore` are intentionally unavailable. It must not tell users to install the old plugin or EAC.

`phase-1-validation.md` records:

```markdown
# Phase 1 Validation

## Environment
- Windows version
- Node and pnpm versions
- Git commit

## Commands and results
- pnpm verify:clean
- pnpm test:phase1
- pnpm assert:portable

## Safety evidence
- Platform tree hashes before/after
- Second-scan database counters
- Live-home guard result
- Unsupported adapter result

## Deferred by design
- DSH writes and Dashboard: phase two
- Codex continuation creation: phase three
- Codex native mirror: phase four
```

Replace each list item with the actual captured value/result before committing; a missing value fails `portable-package.test.ts` by matching blank bullet endings.

- [ ] **Step 6: Add final scripts and run the complete gate**

Root scripts become:

```json
"test:phase1": "vitest run packages apps tests/contract tests/integration",
"assert:portable": "node scripts/assert-portable.mjs",
"check": "pnpm typecheck && pnpm test:phase1 && pnpm build && pnpm assert:portable",
"verify:clean": "pnpm bootstrap && pnpm check"
```

Run:

```powershell
pnpm verify:clean
git diff --check
$clone = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh-session-maint-' + [guid]::NewGuid())
git clone . $clone
pnpm --dir $clone bootstrap
pnpm --dir $clone check
git -C $clone status --short
```

Expected: every command passes; the clean clone has no tracked changes; live platform hashes are never read by the test suite.

- [ ] **Step 7: Commit P13 and stop at the phase gate**

```powershell
git add package.json README.md .github/workflows/ci.yml scripts tests docs/validation/phase-1-validation.md docs/changes/DSH-SESSION-MAINTENANCE-20260826-013.md
git commit -m "test: validate read-only session maintenance core"
git status --short --branch
```

Expected: clean feature branch. Do not uninstall `dsh-codex-session-sync`, install a DSH plugin, write a real DSH session, start phase two, or create a GitHub remote until the user reviews the phase-one validation report.

---

## Phase-one completion checklist

- [ ] P1–P13 each have one focused commit and one Markdown change report.
- [ ] `pnpm verify:clean` passes on Node `22.19.0` and `24.x` Windows runners.
- [ ] The same fixture scan twice creates no duplicate LogicalSession, PlatformBinding or SessionVersion.
- [ ] `UNSTABLE_READ`, `PLAN_STALE`, `ADAPTER_INCOMPATIBLE`, identity conflict and unsupported write capability are covered by tests.
- [ ] Codex and DSH fixture file hashes are identical before and after every scan/plan flow.
- [ ] No runtime package imports or executes the old synchronizer, EAC or Maintenance service.
- [ ] CLI/API accept roots only through trusted CLI instance registration; HTTP accepts IDs only.
- [ ] Phase-one validation report contains actual commands, commit and safety evidence.
- [ ] Work stops for user review before phase-two planning and execution.
