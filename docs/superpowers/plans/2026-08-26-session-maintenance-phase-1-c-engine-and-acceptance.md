# Session Maintenance Phase 1C Engine and Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把两套只读适配器编排为幂等发现、CLI、受保护 loopback API 和持久化作业，并完成阶段一零平台写入验收。

**Architecture:** DiscoveryService 是唯一版本发现入口，ReadOnlyEngine 是 CLI/API 的共同 composition root。HTTP 使用已登记 instance ID 和 capability token，扫描通过可恢复的持久化作业执行。

**Tech Stack:** TypeScript、Vitest、Commander `14.0.0`、YAML `2.8.1`、Node HTTP/SSE、SQLite。

**Spec:** `../specs/2026-08-26-dsh-codex-session-maintenance-design.md`（重点读取 §7、§9–§10、§16–§21）

**Parent plan:** `2026-08-26-session-maintenance-phase-1-readonly-core.md`

## Global Constraints

- 仅在批次 A/B 门禁通过后执行；继承主计划全部约束。
- CLI 是唯一可登记本机路径的可信入口；HTTP 和客户端只传 ID。
- Discovery 不自动设置 canonical ref，不按标题自动合并，不调用任何平台 write 方法。
- 阶段一的 apply/restore HTTP 路由保留稳定形状，但始终返回 `CAPABILITY_NOT_AVAILABLE`。
- P10–P13 串行提交；P13 完成后停止。

---

### Task P10: Discover sessions idempotently and propose matches

**Files:**
- Create: `packages/session-domain/src/discovery.ts`
- Modify: `packages/session-domain/src/index.ts`, `packages/session-store/src/repository.ts`
- Create: `tests/integration/helpers/read-only-system.ts`
- Test: `packages/session-domain/test/discovery.test.ts`
- Test: `tests/integration/{discovery-idempotence,discovery-conflicts}.test.ts`
- Create: `docs/changes/DSH-SESSION-MAINTENANCE-20260826-010.md`

**Interfaces:**
- Consumes: P4 graph classification, P5 repository, P8/P9 read adapters.
- Produces: `DiscoveryService.scanInstance(instanceId): Promise<DiscoveryResult>`, `scanAll(instanceIds?): Promise<DiscoveryResult>`, deterministic logical/version/binding/candidate IDs, observed refs and unresolved `MatchCandidate`.

- [ ] **Step 1: Write and run idempotence/identity tests**

```ts
const system = await createReadOnlyTestSystem();
const first = await system.discovery.scanAll();
const counts = await system.repository.counts();
const second = await system.discovery.scanAll();
expect(second.createdVersions).toBe(0);
expect(second.createdBindings).toBe(0);
expect(await system.repository.counts()).toEqual(counts);
expect(first.platformWrites + second.platformWrites).toBe(0);
```

Add explicit provenance, title-only, reused UUID and unstable-read cases. Run discovery tests; expected: FAIL on missing service/repository methods.

`tests/integration/helpers/read-only-system.ts` exports `createReadOnlyTestSystem(): Promise<{sandbox,repository,discovery,platformRoots,cleanup}>`; it always materializes both marked fixture homes and cannot accept caller-provided platform roots.

- [ ] **Step 2: Implement deterministic observation identities**

```ts
logicalSessionId = `ls_${sha256Canonical({ platform, instanceId, sessionId }).slice(0, 24)}`;
versionId = `sv_${sha256Canonical({ logicalSessionId, parents, bodyHash, metadataHash }).slice(0, 24)}`;
bindingId = `binding_${sha256Canonical(key).slice(0, 24)}`;
candidateId = `match_${sha256Canonical({ leftBindingId, rightKey, reason }).slice(0, 24)}`;
```

First observation has zero parents; changed observation uses the previous observed version as its only parent. Equal normalized content reuses the existing version and updates only scan metadata/ref.

- [ ] **Step 3: Implement the matching policy**

Auto-bind only explicit cross-platform provenance plus equal/prefix-compatible content. Existing exact platform key updates its binding. Equal root/prefix plus stable workspace ID produces a high-confidence candidate requiring confirmation. Equal title produces only a low candidate. Reused UUID with unrelated content produces blocking `IDENTITY_CONFLICT`.

- [ ] **Step 4: Make discovery transactionally idempotent**

Complete the parent-plan repository with `findBinding`, `bindPlatformSession`, `getObservedHead`, `upsert/listMatchCandidates`, `listBindings`, `counts`, `recordObservedVersion`, `listSessions`, and `getGraphPage`; P5/P6 already supply its other methods. Store body object first, then `recordObservedVersion()` inserts logical/version/parent/binding/ref/candidate changes in one SQLite transaction. Unstable observations create nothing; scans never move canonical ref.

- [ ] **Step 5: Verify zero platform writes, report and commit P10**

`createReadOnlyTestSystem()` builds marked Codex/DSH homes and real temporary storage without accepting live roots. Hash both platform trees before/after two scans. Run P10 and root tests; expected: identical trees, valid refs and null canonical refs.
Write `...010.md` and commit as `feat: discover session versions idempotently`.

---

### Task P11: Compose the Engine and expose the CLI

**Files:**
- Create: `apps/engine/{package.json,tsconfig.json}`
- Create: `apps/engine/src/{config,composition-root,engine,cli,main}.ts`
- Create: `apps/engine/test/helpers.ts`
- Test: `apps/engine/test/{config,cli}.test.ts`
- Create: `docs/changes/DSH-SESSION-MAINTENANCE-20260826-011.md`

**Interfaces:**
- Consumes: repository, discovery, planner and both read adapters.
- Produces: parent-plan `ReadOnlyEngine`; binary `dsh-session-maint`; commands `init`, `instance add/list`, `scan`, `diff`, `plan`, `status`, unsupported `apply/restore`.

- [ ] **Step 1: Write and run CLI boundary tests**

```ts
const fixture = await createFixtureSystem("cli");
const before = await hashTree(fixture.platformRoot);
await runCli(["--state-root", fixture.stateRoot, "instance", "add", "--id", "codex-fixture", "--platform", "codex", "--root", fixture.codexHome, "--platform-version", "0.146.0", "--json"], fixture);
const result = await runCli(["--state-root", fixture.stateRoot, "scan", "--instance", "codex-fixture", "--json"], fixture);
expect(JSON.parse(result.stdout).createdVersions).toBe(1);
expect(await hashTree(fixture.platformRoot)).toEqual(before);
```

Also expect `apply --plan plan_x` to exit `2` with `CAPABILITY_NOT_AVAILABLE`. Run Engine tests; expected: FAIL because the app is absent.

`apps/engine/test/helpers.ts` exports `createFixtureSystem(name)`, `runCli(argv, fixture)` and `hashTree(root)`. It returns only marked temporary roots, invokes the CLI in process with captured stdout/stderr and hashes relative paths plus bytes.

- [ ] **Step 2: Implement validated Engine-private configuration**

`config.yaml` schema is `{ schemaVersion: 1, instances: Record<id,{platform,displayName,root,platformVersion}> }`. Only `instance add` accepts `root`; resolve realpath and require adapter probe success before an atomic temp+fsync+rename write. HTTP schemas never reuse this configuration type.

- [ ] **Step 3: Build one composition root**

`createReadOnlyComposition({ stateRoot, clock?, fixturePolicy? })` opens `metadata.sqlite` and `objects/`, loads config, registers one adapter per platform, and returns the exact `ReadOnlyEngine` from the parent plan. No command constructs adapters or opens SQLite independently.

- [ ] **Step 4: Implement the fixed CLI surface**

```text
dsh-session-maint init
dsh-session-maint instance add|list
dsh-session-maint scan (--instance <id> | --all)
dsh-session-maint diff --logical-session <id> [--source <binding>] [--target <binding>]
dsh-session-maint plan --logical-session <id> --source <binding> [--target <binding>]
dsh-session-maint status
dsh-session-maint apply --plan <id>
dsh-session-maint restore --transaction <id>
```

JSON mode emits one object to stdout; diagnostics use stderr and exclude token/body content. `apply/restore` create no transaction directory in phase one.

- [ ] **Step 5: Verify CLI safety, report and commit P11**

Cover invalid platform version, duplicate instance, wrong root type, missing instance/logical session, repeated scan and unsupported writes. Run Engine and root tests.
Write `...011.md` and commit as `feat: expose read-only session maintenance CLI`.

---

### Task P12: Add authenticated loopback API, jobs and typed client

**Files:**
- Create: `apps/engine/src/jobs/{job-runner,job-store}.ts`
- Create: `apps/engine/src/http/{auth,body,routes,server,sse}.ts`
- Modify: `apps/engine/src/{engine,cli}.ts`, `apps/engine/test/helpers.ts`
- Create: `packages/session-store/src/migrations/002-job-events.ts`
- Create: `packages/local-api-client/{package.json,tsconfig.json}`
- Create: `packages/local-api-client/src/{client,event-stream,index}.ts`
- Test: `apps/engine/test/{http-api,job-runner}.test.ts`, `packages/local-api-client/test/client.test.ts`
- Create: `docs/changes/DSH-SESSION-MAINTENANCE-20260826-012.md`

**Interfaces:**
- Consumes: `ReadOnlyEngine`, P2 job/HTTP DTOs.
- Produces: `MaintenanceClient.listSessions/getGraph/getDiff/createPlan/getPlan/scan/subscribe`, authenticated HTTP/SSE, persistent scan jobs, connection file. `scan()` returns `JobRef`; `subscribe(jobId)` returns `AsyncIterable<JobEvent>`.

- [ ] **Step 1: Write and run HTTP/auth plus persistent-job tests**

```ts
const fixture = await createEngineFixture("http");
const server = await fixture.startServer({ host: "127.0.0.1", port: 0 });
expect((await fetch(`${server.origin}/v1/sessions`)).status).toBe(401);
expect((await fetch(`${server.origin}/v1/sessions`, { headers: { authorization: `Bearer ${server.token}` } })).status).toBe(200);
await expect(fixture.startServer({ host: "0.0.0.0", port: 0 })).rejects.toThrow(/LOOPBACK_ONLY/);
```

`helpers.ts` adds `createEngineFixture(name)`, which composes the real Engine on a marked temporary state root and returns `{ engine, stateRoot, startServer, stop, cleanup }`; it has no live-root parameter. Add malicious Origin, 64 KiB overflow, path field and unsupported apply tests. In the same red-test pass, enqueue a scan and assert `queued → running → progress → completed` with monotonically increasing sequence; restart with queued/running scan jobs and assert each is requeued exactly once. Unknown/non-idempotent interrupted kinds become failed with `RECOVERY_REQUIRED`. Run HTTP/job tests; expected: FAIL on missing server, runner and migration.

- [ ] **Step 2: Implement connection security**

Generate 32 random bytes and write `{schemaVersion:1,host:"127.0.0.1",port,token}` to `<stateRoot>/connection.json`. Use mode `0o600`; on Windows invoke `whoami.exe` then `icacls.exe` with an argv array and `shell:false` to remove inheritance and grant only that account. Redact token from all logs/errors.

- [ ] **Step 3: Implement the bounded routes and SSE**

```text
GET  /v1/health
GET  /v1/instances
GET  /v1/sessions
GET  /v1/sessions/:id/graph
POST /v1/diffs
POST /v1/jobs/scan
GET  /v1/jobs/:id
GET  /v1/jobs/:id/events
POST /v1/plans
GET  /v1/plans/:id
POST /v1/plans/:id/apply
POST /v1/transactions/:id/restore
```

Bind only `127.0.0.1`; require bearer auth for `/v1/*` except health; if Origin exists it must equal server origin. Set no-store, nosniff and restrictive CSP. Strict bodies max at 64 KiB; pagination defaults 50, caps 200; resolve roots only from Engine config.

- [ ] **Step 4: Implement the typed client and recovery queue**

`MaintenanceClient({ origin, token, fetchImpl? })` validates every response with P2 schemas, exposes list/graph/diff/plan/job/subscription calls, converts SSE to `JobEvent`, supports AbortSignal and never includes token in errors. Job state/event writes are SQLite transactions; phase-one scan is the only resumable kind.

- [ ] **Step 5: Verify, report and commit P12**

Test pagination, graph, diff, plan lookup, SSE resume, malformed JSON, abort, stale plan, ACL argv and token redaction. Hash platform fixtures around jobs. Run common validation, write `...012.md`, commit as `feat: serve read-only maintenance jobs locally`.

---

### Task P13: Complete phase-one acceptance and portability gate

**Files:**
- Create: `scripts/assert-portable.mjs`
- Test: `tests/contract/portable-package.test.ts`
- Test: `tests/integration/{phase-1-acceptance,phase-1-large-catalog}.test.ts`
- Create: `README.md`, `docs/validation/phase-1-validation.md`
- Modify: `docs/validation/phase-1-progress.md`
- Create: `docs/changes/DSH-SESSION-MAINTENANCE-20260826-013.md`
- Modify: `package.json`, `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: all P1–P12 deliverables.
- Produces: `pnpm test:phase1`, `pnpm assert:portable`, reproducible read-only phase-one candidate and validation evidence.

- [ ] **Step 1: Write and run the acceptance matrix**

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

For every case, hash both platform trees, scan twice, assert second-scan zero creates, make a plan and compare operation/reason. Run acceptance tests; expected: FAIL until final counters/query paths exist.

- [ ] **Step 2: Write and run the lazy-catalog contract**

Create 1,000 synthetic summaries with a counting adapter. First scan may observe new bodies; second unchanged scan performs zero full observations with adapter concurrency `<=4`. First API page reads zero body objects; one graph page reads only that logical session’s manifests.

- [ ] **Step 3: Close measured gaps without adding phase-two scope**

Add missing counters/pagination only through existing repository/Engine paths. Cache `{size,mtimeNs,sourceHash,eventCount}` only, use a four-worker read pool and one SQLite write queue. Do not add watcher, Dashboard, DSH writer, Codex creator or platform mutation.

- [ ] **Step 4: Implement portability and clean-clone checks**

Reject runtime absolute paths, `file:`/`link:` dependencies, non-allowlisted `workspace:` dependencies, compiled source-path imports, old synchronizer/EAC runtime references, and credential canaries. Tests/docs may contain forbidden examples but are still included in the credential-canary scan. Clone into a new temporary directory, run bootstrap/check and assert a clean worktree.

- [ ] **Step 5: Write validation documents, run the final gate, commit and stop**

README states phase one is read-only, supports Codex `0.146.0` and DSH `0.1.1-rc.2`, and documents init/register/scan/diff/plan/status. Validation records Windows, Node/pnpm, commit, exact command results, platform hash evidence, second-scan counters, live-home rejection and unsupported adapter result. No blank evidence fields may remain.
Run `pnpm verify:clean`, `pnpm test:phase1`, `pnpm assert:portable`, temporary clean-clone validation, `git diff --check`, and `git status --short --branch`. Write `...013.md`, update `phase-1-progress.md`, commit as `test: validate read-only session maintenance core`. Stop before uninstalling the old plugin, installing a DSH plugin, writing a real platform session or starting phase two.
