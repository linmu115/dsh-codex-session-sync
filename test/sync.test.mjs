import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  decodeArtifact,
  encodeArtifact,
  execute,
  hasOnlyBenignRuntimeTail,
  hasNativeDialogue,
  isApprovalTranscript,
  isRedundantBranch,
  migrateImportedSessionEvents,
  projectKey,
} from '../sync/sync.mjs'

const NODE_ID = '11111111-2222-4333-8444-555555555555'
const ARCHIVED_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const EXCLUDED_ID = '99999999-8888-4777-8666-555555555555'

test('approval-review transcripts are excluded without matching normal conversations', () => {
  assert.equal(isApprovalTranscript('The following is the Codex agent history whose request action you are assessing.\n...'), true)
  assert.equal(isApprovalTranscript('  The following is the Codex agent history added since your last approval assessment.\n...'), true)
  assert.equal(isApprovalTranscript('Please discuss the approval transcript embedded below.'), false)
})

test('DSH path encoding matches the rc.6 project layout', () => {
  assert.equal(projectKey('C:\\Users\\test\\项目'), '--C-Users-test-~9879~76EE--')
})

test('multi-frame artifact codec preserves header and events', () => {
  const header = { version: 0, id: NODE_ID, createdAt: 123, cwd: 'C:\\work', delegationDepth: 0 }
  const events = [{ type: 'session/title', seq: 0, time: 123, data: { title: '标题', messageSeqs: [], source: { kind: 'user' } } }]
  const decoded = decodeArtifact(encodeArtifact(header, events))
  assert.equal(decoded.header.id, NODE_ID)
  assert.deepEqual(decoded.events, events)
  assert.equal(decoded.frameCount, 2)
})

test('RC2 import marker migration removes the private event and remaps seq references', () => {
  const original = [
    { type: 'session/imported', seq: 0, time: 1, ignorable: true, data: { tool: 'codex', sourceId: NODE_ID } },
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    { type: 'tool/call', seq: 2, time: 1, data: { callId: 'call-1' } },
    { type: 'tool/result', seq: 3, time: 1, sourceEventSeqs: [2], data: { callId: 'call-1' } },
  ]
  const result = migrateImportedSessionEvents(original)
  assert.equal(result.changed, true)
  assert.deepEqual(result.provenance, { tool: 'codex', sourceId: NODE_ID })
  assert.deepEqual(result.events.map((event) => [event.type, event.seq]), [
    ['turn/start', 0], ['tool/call', 1], ['tool/result', 2],
  ])
  assert.deepEqual(result.events[2].sourceEventSeqs, [1])
  assert.equal(migrateImportedSessionEvents(result.events).changed, false)
})

test('runtime end-seed markers do not count as a runtime conversation divergence', () => {
  const imported = [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }]
  assert.equal(hasOnlyBenignRuntimeTail([
    ...imported,
    { type: 'session/end-seed', seq: 1, time: 2, data: {} },
    { type: 'session/end-seed', seq: 2, time: 3, data: {} },
  ], imported.length), true)
  assert.equal(hasOnlyBenignRuntimeTail([
    ...imported,
    { type: 'user/message', seq: 1, time: 2, data: { content: [] } },
  ], imported.length), false)
})

test('same-ID imported dialogue is not a native edit, while native messages are', () => {
  const imported = [
    { type: 'user/message', data: { id: `import:${NODE_ID}:u1` } },
    { type: 'assistant/message', data: { message: { id: `import:${NODE_ID}:a1:1` } } },
  ]
  assert.equal(hasNativeDialogue(imported, NODE_ID), false)
  assert.equal(hasNativeDialogue([
    ...imported,
    { type: 'user/message', data: { id: 'local-message' } },
  ], NODE_ID), true)
})

test('redundant branches are old prefixes while real native dialogue is preserved', () => {
  const oldCore = [{ type: 'user/message', seq: 0, time: 1, data: { content: [] } }]
  const newCore = [...oldCore, { type: 'assistant/message', seq: 1, time: 2, data: { message: {} } }]
  const managedTail = [
    { type: 'session/title', seq: 2, time: 3, data: { title: '分支' } },
    { type: 'session/end-seed', seq: 3, time: 4, data: {} },
  ]
  assert.equal(isRedundantBranch([...oldCore, ...managedTail], [...newCore, ...managedTail]), true)
  assert.equal(isRedundantBranch([
    ...oldCore,
    { type: 'user/message', seq: 1, time: 5, data: { content: [{ type: 'text', text: '新的本地对话' }] } },
    ...managedTail,
  ], [...newCore, ...managedTail]), false)

  const oldFormat = [
    { type: 'user/message', seq: 10, time: 10, data: { content: [{ type: 'text', text: '同一个问题' }] } },
    { type: 'assistant/message', seq: 11, time: 11, data: { message: { content: [{ type: 'text', text: '同一个回答' }] } } },
    ...managedTail,
  ]
  const newFormat = [
    { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: '同一个问题' }] } },
    { type: 'assistant/message', seq: 1, time: 2, data: { message: { content: [{ type: 'text', text: '同一个回答' }] } } },
    { type: 'user/message', seq: 2, time: 3, data: { content: [{ type: 'text', text: '后续问题' }] } },
    ...managedTail,
  ]
  assert.equal(isRedundantBranch(oldFormat, newFormat), true)
  oldFormat[1].data.message.content[0].text = '本地不同的回答'
  assert.equal(isRedundantBranch(oldFormat, newFormat), false)
})

test('one-way sync uses exact UUID/title and branches DSH divergence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-dsh-sync-'))
  const codexRoot = join(root, '.codex')
  const dshHome = join(root, '.dsh')
  const cwd = join(root, 'workspace')
  const excludedCwd = join(root, 'excluded-workspace')
  const rolloutDir = join(codexRoot, 'sessions', '2026', '08', '18')
  const rollout = join(rolloutDir, `rollout-test-${NODE_ID}.jsonl`)
  await mkdir(rolloutDir, { recursive: true })
  await mkdir(cwd, { recursive: true })
  await mkdir(join(dshHome, 'storages'), { recursive: true })
  const nativeId = 'session-native'
  await writeFile(join(dshHome, 'storages', 'workspace.json'), `${JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['workspace-1', 'workspace-archived', 'workspace-excluded'], archivedSessionIds: [] },
    tables: {
      workspaces: {
        'workspace-1': {
          path: cwd,
          title: 'workspace',
          sessionIds: [nativeId, `import-${NODE_ID}`, `${NODE_ID}--branch-stale`],
          createdAt: '2026-08-18T10:00:00.000Z',
          updatedAt: '2026-08-18T10:00:00.000Z',
        },
        'workspace-archived': {
          path: join(root, 'archived-workspace'),
          title: 'archived-workspace',
          sessionIds: [ARCHIVED_ID],
          createdAt: '2026-08-18T10:00:00.000Z',
          updatedAt: '2026-08-18T10:00:00.000Z',
        },
        'workspace-excluded': {
          path: excludedCwd,
          title: 'excluded-workspace',
          sessionIds: [EXCLUDED_ID],
          createdAt: '2026-08-18T10:00:00.000Z',
          updatedAt: '2026-08-18T10:00:00.000Z',
        },
      },
    },
  }, null, 2)}\n`)
  const nativeHeader = { version: 0, id: nativeId, createdAt: 50, cwd, delegationDepth: 0 }
  const nativeEvents = [
    { type: 'turn/start', seq: 0, time: 50, data: { turn: 1 } },
    { type: 'session/title', seq: 1, time: 51, data: { title: '原生会话', messageSeqs: [], source: { kind: 'user' } } },
  ]
  const nativePath = join(dshHome, 'sessions', projectKey(cwd), nativeId, 'session.jsonl.zstd')
  await mkdir(join(dshHome, 'sessions', projectKey(cwd), nativeId), { recursive: true })
  await writeFile(nativePath, encodeArtifact(nativeHeader, nativeEvents))
  const archivedCwd = join(root, 'archived-workspace')
  const archivedPath = join(dshHome, 'sessions', projectKey(archivedCwd), ARCHIVED_ID, 'session.jsonl.zstd')
  await mkdir(join(dshHome, 'sessions', projectKey(archivedCwd), ARCHIVED_ID), { recursive: true })
  await writeFile(archivedPath, encodeArtifact(
    { version: 0, id: ARCHIVED_ID, createdAt: 40, cwd: archivedCwd, delegationDepth: 0 },
    [{ type: 'session/title', seq: 0, time: 40, data: { title: '已归档会话', messageSeqs: [], source: { kind: 'user' } } }],
  ))
  const excludedPath = join(dshHome, 'sessions', projectKey(excludedCwd), EXCLUDED_ID, 'session.jsonl.zstd')
  await mkdir(join(dshHome, 'sessions', projectKey(excludedCwd), EXCLUDED_ID), { recursive: true })
  await writeFile(excludedPath, encodeArtifact(
    { version: 0, id: EXCLUDED_ID, createdAt: 30, cwd: excludedCwd, delegationDepth: 0 },
    [{ type: 'session/title', seq: 0, time: 30, data: { title: '排除工作区会话', messageSeqs: [], source: { kind: 'user' } } }],
  ))
  await mkdir(join(dshHome, 'codex-oneway-sync'), { recursive: true })
  await writeFile(join(dshHome, 'codex-oneway-sync', 'workspace-exclusions.json'), `${JSON.stringify({
    version: 1,
    paths: [excludedCwd, archivedCwd],
  }, null, 2)}\n`)
  await writeFile(join(dshHome, 'storages', 'session_projcache.json'), `${JSON.stringify({
    unit: { name: 'session_projcache', version: 3 },
    global: null,
    tables: {
      sessions: {
        [nativeId]: {
          identity: { createdAt: 50, cwd },
          rows: { goal: { ver: 4, seq: 1, val: null } },
        },
        stale: {
          identity: { createdAt: 1, cwd },
          rows: { title: { ver: 1, seq: 0, val: '已删除' } },
        },
      },
    },
  }, null, 2)}\n`)
  const rows = [
    { timestamp: '2026-08-18T10:00:00.000Z', type: 'session_meta', payload: { id: NODE_ID, cwd, timestamp: '2026-08-18T10:00:00.000Z' } },
    { timestamp: '2026-08-18T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '原始提问' }] } },
    { timestamp: '2026-08-18T10:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '原始回答' }] } },
  ]
  await writeFile(rollout, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)

  const stateDb = new DatabaseSync(join(codexRoot, 'state_5.sqlite'))
  stateDb.exec(`create table threads (
    id text primary key, rollout_path text, title text, name text, cwd text,
    created_at integer, updated_at integer, archived integer
  )`)
  stateDb.prepare('insert into threads values (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(NODE_ID, rollout, '原始提问', null, cwd, 1, 2, 0)
  stateDb.prepare('insert into threads values (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(ARCHIVED_ID, null, '已归档会话', null, archivedCwd, 1, 2, 1)
  stateDb.close()

  await mkdir(join(codexRoot, 'sqlite'), { recursive: true })
  const catalogDb = new DatabaseSync(join(codexRoot, 'sqlite', 'codex-dev.db'))
  catalogDb.exec(`create table local_thread_catalog (
    thread_id text, display_title text, missing_candidate integer,
    observation_sequence integer, source_recency_at real
  )`)
  catalogDb.prepare('insert into local_thread_catalog values (?, ?, 0, 1, 1)')
    .run(NODE_ID, 'Codex 精确标题 · 甲')
  catalogDb.close()

  await execute({ apply: true, codexRoot, dshHome })
  const project = join(dshHome, 'sessions', projectKey(cwd))
  const canonicalPath = join(project, NODE_ID, 'session.jsonl.zstd')
  let canonical = decodeArtifact(await readFile(canonicalPath))
  assert.equal(canonical.header.id, NODE_ID)
  assert.equal(canonical.events.some((event) => event.type === 'session/imported'), false)
  assert.equal(canonical.events.filter((event) => event.type === 'session/title').at(-1).data.title, 'Codex 精确标题 · 甲')
  const workspace = JSON.parse(await readFile(join(dshHome, 'storages', 'workspace.json'), 'utf8'))
  assert.equal(workspace.global.initialized, true)
  assert.deepEqual(workspace.tables.workspaces['workspace-1'].sessionIds, [nativeId, NODE_ID])
  assert.deepEqual(workspace.global.workspaceIds, ['workspace-1'])
  assert.equal(workspace.tables.workspaces['workspace-archived'], undefined)
  assert.equal(workspace.tables.workspaces['workspace-excluded'], undefined)
  const archivedSessionPath = join(
    dshHome,
    'codex-oneway-sync',
    'archived-sessions',
    projectKey(archivedCwd),
    ARCHIVED_ID,
  )
  assert.equal((await readdir(archivedSessionPath)).includes('session.jsonl.zstd'), true)
  assert.equal((await readdir(join(dshHome, 'sessions', projectKey(excludedCwd), EXCLUDED_ID))).includes('session.jsonl.zstd'), true)
  let projectionCache = JSON.parse(await readFile(join(dshHome, 'storages', 'session_projcache.json'), 'utf8'))
  assert.equal(projectionCache.tables.sessions[NODE_ID].rows.title.val, 'Codex 精确标题 · 甲')
  assert.equal(projectionCache.tables.sessions[NODE_ID].rows.title.ver, 1)
  assert.equal(projectionCache.tables.sessions[NODE_ID].rows.sessionListMetadata.val.blank, false)
  assert.equal(projectionCache.tables.sessions[nativeId].rows.title.val, '原生会话')
  assert.deepEqual(projectionCache.tables.sessions[nativeId].rows.goal, { ver: 4, seq: 1, val: null })
  assert.equal(projectionCache.tables.sessions.stale, undefined)
  assert.equal(projectionCache.tables.sessions[ARCHIVED_ID], undefined)

  const unchanged = await execute({ apply: true, codexRoot, dshHome })
  assert.equal(unchanged.counters.unchanged, 1)

  canonical.events.push({
    type: 'session/end-seed',
    seq: canonical.events.at(-1).seq + 1,
    time: Date.now(),
    data: {},
  })
  await writeFile(canonicalPath, encodeArtifact(canonical.header, canonical.events))
  const runtimeTail = await execute({ apply: true, codexRoot, dshHome })
  assert.equal(runtimeTail.counters.unchanged, 1)
  assert.equal(runtimeTail.counters.branched, 0)

  canonical.events.push({
    type: 'session/title',
    seq: canonical.events.at(-1).seq + 1,
    time: Date.now(),
    data: { title: '本地私改标题', messageSeqs: [], source: { kind: 'user' } },
  })
  await writeFile(canonicalPath, encodeArtifact(canonical.header, canonical.events))
  const titleOnly = await execute({ apply: true, codexRoot, dshHome })
  assert.equal(titleOnly.counters.branched, 0)
  canonical = decodeArtifact(await readFile(canonicalPath))
  assert.equal(canonical.events.filter((event) => event.type === 'session/title').at(-1).data.title, 'Codex 精确标题 · 甲')
  projectionCache = JSON.parse(await readFile(join(dshHome, 'storages', 'session_projcache.json'), 'utf8'))
  assert.equal(projectionCache.tables.sessions[NODE_ID].rows.title.val, 'Codex 精确标题 · 甲')

  canonical.events.push({
    type: 'user/message',
    seq: canonical.events.at(-1).seq + 1,
    time: Date.now(),
    data: {
      id: 'local-message',
      role: 'user',
      content: [{ type: 'text', text: '本地独立追加的对话' }],
      source: { kind: 'user' },
    },
  })
  await writeFile(canonicalPath, encodeArtifact(canonical.header, canonical.events))
  const diverged = await execute({ apply: true, codexRoot, dshHome })
  assert.equal(diverged.counters.branched, 1)

  const dirs = await readdir(project)
  const branchId = dirs.find((name) => name.startsWith(`${NODE_ID}--branch-`))
  assert.ok(branchId)
  const branch = decodeArtifact(await readFile(join(project, branchId, 'session.jsonl.zstd')))
  assert.equal(branch.header.id, branchId)
  assert.match(branch.events.filter((event) => event.type === 'session/title').at(-1).data.title, /分支/)

  const pruned = await execute({ apply: true, codexRoot, dshHome, pruneRedundantBranches: true })
  assert.equal(pruned.counters.redundantBranchesPruned, 0)
  assert.equal((await readdir(project)).includes(branchId), true)

  await rm(root, { recursive: true, force: true })
})
