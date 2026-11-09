import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, readdir, writeFile, mkdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  NOOP,
  createLogger,
  newRunId,
  sanitize,
  resolveLogDir,
  assertOutsideGit,
  renderSummary,
} from '../lib/telemetry.js'

async function sandbox(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'memdream-tel-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
  }
}

/** Read events.jsonl into objects. */
async function readEvents(dir) {
  const text = await readFile(join(dir, 'events.jsonl'), 'utf8')
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

// ---------------------------------------------------------------- ids

test('run ids are unique and prefixed', () => {
  const ids = new Set()
  for (let i = 0; i < 200; i++) ids.add(newRunId())
  assert.equal(ids.size, 200)
  for (const id of ids) assert.match(id, /^run_[0-9a-z]+_[0-9a-z]{4}$/)
})

// ---------------------------------------------------------------- redaction

test('sanitize redacts forbidden keys', () => {
  const out = sanitize({
    ok: true,
    text: 'secret memory content',
    content: 'more',
    apiKey: 'sk-123',
    nested: { token: 'abc', count: 3 },
  })
  assert.equal(out.ok, true)
  assert.equal(out.text, '[redacted]')
  assert.equal(out.content, '[redacted]')
  assert.equal(out.apiKey, '[redacted]')
  assert.equal(out.nested.token, '[redacted]')
  assert.equal(out.nested.count, 3)
})

test('sanitize truncates long strings and caps arrays', () => {
  const out = sanitize({
    long: 'x'.repeat(500),
    many: Array.from({ length: 50 }, (_, i) => i),
  })
  assert.ok(out.long.length <= 201)
  assert.match(out.long, /…$/)
  assert.equal(out.many.length, 21)
  assert.match(String(out.many.at(-1)), /more/)
})

test('sanitize bounds depth', () => {
  const deep = { a: { b: { c: { d: { e: 1 } } } } }
  const out = sanitize(deep)
  assert.equal(out.a.b.c, '[depth]')
})

test('sanitize passes primitives through', () => {
  assert.equal(sanitize(1), 1)
  assert.equal(sanitize(true), true)
  assert.equal(sanitize(null), null)
  assert.equal(sanitize(undefined), undefined)
})

// ---------------------------------------------------------------- logger

test('disabled logger is the shared no-op', () => {
  assert.equal(NOOP.enabled, false)
  assert.equal(NOOP.runId, null)
  // Must not throw when called.
  NOOP.event('anything', { a: 1 })
  NOOP.child({ x: 1 }).event('nested')
})

test('logger writes one JSON object per line', async () => {
  await sandbox(async (dir) => {
    const log = createLogger({ dir })
    log.event('a', { n: 1 })
    log.event('b', { n: 2 })
    await log.flush()

    const events = await readEvents(dir)
    assert.equal(events.length, 2)
    assert.equal(events[0].type, 'a')
    assert.equal(events[0].n, 1)
    assert.equal(events[1].type, 'b')
    for (const e of events) {
      assert.ok(e.ts, 'every event carries a timestamp')
      assert.equal(e.runId, log.runId)
    }
  })
})

test('logger redacts forbidden fields even when a caller passes them', async () => {
  await sandbox(async (dir) => {
    const log = createLogger({ dir })
    log.event('leak', { text: 'should not appear', ok: true })
    await log.flush()
    const raw = await readFile(join(dir, 'events.jsonl'), 'utf8')
    assert.doesNotMatch(raw, /should not appear/)
    assert.match(raw, /\[redacted\]/)
  })
})

test('child loggers share the run id and merge base fields', async () => {
  await sandbox(async (dir) => {
    const log = createLogger({ dir, base: { version: '1' } })
    const child = log.child({ tool: 'memory' })
    child.event('x', { n: 1 })
    await log.flush()
    const [e] = await readEvents(dir)
    assert.equal(e.runId, log.runId)
    assert.equal(e.version, '1')
    assert.equal(e.tool, 'memory')
  })
})

test('a logging failure does not throw', async () => {
  await sandbox(async (dir) => {
    // Point the logger at a path that cannot be a directory.
    const blocker = join(dir, 'blocked')
    await writeFile(blocker, 'not a directory')
    const log = createLogger({ dir: join(blocker, 'sub') })
    assert.doesNotThrow(() => log.event('x', { n: 1 }))
    await assert.doesNotReject(() => log.flush())
  })
})

test('an unserializable field does not throw', async () => {
  await sandbox(async (dir) => {
    const log = createLogger({ dir })
    const circular = { a: 1 }
    circular.self = circular
    assert.doesNotThrow(() => log.event('x', circular))
    await log.flush()
    const events = await readEvents(dir)
    assert.equal(events.length, 1)
  })
})

test('log files are created owner-only', { skip: process.platform === 'win32' }, async () => {
  await sandbox(async (dir) => {
    const log = createLogger({ dir })
    log.event('x')
    await log.flush()
    const info = await stat(join(dir, 'events.jsonl'))
    // 0o600: no group or world access.
    assert.equal(info.mode & 0o077, 0)
  })
})

test('rotation keeps the file under the cap and prunes old files', async () => {
  await sandbox(async (dir) => {
    const log = createLogger({ dir, maxBytes: 400, maxFiles: 2 })
    for (let i = 0; i < 60; i++) log.event('x', { i, pad: 'y'.repeat(20) })
    await log.flush()

    const files = await readdir(dir)
    const rotated = files.filter((f) => f.startsWith('events.jsonl.'))
    assert.ok(rotated.length > 0, 'the file must have rotated')
    assert.ok(rotated.length <= 2, `kept ${rotated.length} rotated files, cap is 2`)
  })
})

// ---------------------------------------------------------------- summary

test('finish writes a human summary', async () => {
  await sandbox(async (dir) => {
    const log = createLogger({ dir })
    await log.finish({
      durationMs: 42,
      outcome: 'record written',
      memoryEntries: 3,
      memoryChars: 120,
      memoryCap: 4000,
      notesRead: 2,
      sessionsRead: 5,
      transcriptChars: 900,
      workspaceMatched: true,
      recordWritten: true,
      recordAppended: false,
      synthesisWritten: false,
    })
    const body = await readFile(join(dir, 'runs', `${log.runId}.md`), 'utf8')
    assert.match(body, /# Dream run run_/)
    assert.match(body, /duration: 42 ms/)
    assert.match(body, /sessions read: 5/)
    assert.match(body, /record written: yes/)
  })
})

test('summary reports a workspace fallback', () => {
  const body = renderSummary({
    runId: 'run_x',
    startedAt: Date.now(),
    summary: { workspaceMatched: false },
  })
  assert.match(body, /matched nothing, fell back to all/)
})

test('summary lists warnings', () => {
  const body = renderSummary({
    runId: 'run_x',
    startedAt: Date.now(),
    summary: { warnings: ['transcript error: boom', '2 blocked memory entries'] },
  })
  assert.match(body, /## Warnings/)
  assert.match(body, /transcript error: boom/)
})

// ---------------------------------------------------------------- location

test('resolveLogDir defaults outside the memory root', () => {
  const dir = resolveLogDir({ logDir: null }, '/home/u/.dsh/memory')
  assert.ok(!dir.startsWith('/home/u/.dsh/memory/'), 'must not nest inside the memory root')
  assert.match(dir, /\.dsh-memory-dream-logs/)
})

test('resolveLogDir honours an explicit path', () => {
  assert.equal(resolveLogDir({ logDir: '/tmp/logs' }, '/x'), '/tmp/logs')
})

test('assertOutsideGit refuses a path inside a worktree', async () => {
  await sandbox(async (dir) => {
    await mkdir(join(dir, 'repo', '.git'), { recursive: true })
    const inside = await assertOutsideGit(join(dir, 'repo', 'logs'))
    assert.equal(inside.ok, false)
    assert.match(inside.reason, /git worktree/)

    const outside = await assertOutsideGit(join(dir, 'elsewhere'))
    assert.equal(outside.ok, true)
  })
})

// ---------------------------------------------------------------- stop/release

test('stop() prevents any further writes', async () => {
  await sandbox(async (dir) => {
    const log = createLogger({ dir })
    log.stop('unsafe location')
    log.event('should-not-land')
    await log.flush()

    const files = await readdir(dir).catch(() => [])
    assert.equal(files.length, 0, 'a stopped logger must write nothing')
    assert.equal(log.active, false)
    assert.equal(log.error, 'unsafe location')
  })
})

test('release() resumes after a stop', async () => {
  await sandbox(async (dir) => {
    const log = createLogger({ dir })
    log.stop('awaiting check')
    log.event('dropped')
    log.release()
    log.event('kept')
    await log.flush()

    const events = await readEvents(dir)
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'kept')
    assert.equal(log.active, true)
    assert.equal(log.error, null)
  })
})

test('a write failure is visible through error and active', async () => {
  await sandbox(async (dir) => {
    const blocker = join(dir, 'blocked')
    await writeFile(blocker, 'not a directory')
    const log = createLogger({ dir: join(blocker, 'sub') })
    assert.equal(log.error, null)

    log.event('x')
    await log.flush()
    assert.equal(log.active, false)
    assert.match(log.error, /ENOTDIR|not a directory/)
  })
})

// ---------------------------------------------------------------- run ids

test('forRun() gives each unit of work its own id', async () => {
  await sandbox(async (dir) => {
    const plugin = createLogger({ dir })
    const a = plugin.forRun()
    const b = plugin.forRun()
    assert.notEqual(a.runId, b.runId, 'two runs must not share an id')
    assert.notEqual(a.runId, plugin.runId, 'a run must not reuse the plugin id')

    a.event('dream.start')
    b.event('dream.start')
    await plugin.flush()

    const events = await readEvents(dir)
    assert.equal(new Set(events.map((e) => e.runId)).size, 2)
  })
})

test('forRun() shares the write queue with the plugin logger', async () => {
  await sandbox(async (dir) => {
    const plugin = createLogger({ dir })
    const run = plugin.forRun()
    run.event('a')
    // Flushing the parent must wait for the child's write.
    await plugin.flush()
    const events = await readEvents(dir)
    assert.equal(events.length, 1)
  })
})

test('several dreams leave several summaries, not one overwritten file', async () => {
  await sandbox(async (dir) => {
    const plugin = createLogger({ dir })
    for (let i = 1; i <= 3; i++) {
      const run = plugin.forRun()
      await run.finish({ durationMs: i, outcome: `pass ${i}` })
    }
    const files = await readdir(join(dir, 'runs'))
    assert.equal(files.length, 3, 'each dream must keep its own summary')
    for (const f of files) {
      const body = await readFile(join(dir, 'runs', f), 'utf8')
      assert.match(body, /pass [123]/)
    }
  })
})

// ---------------------------------------------------------------- retention

test('run summaries are pruned to maxRuns', async () => {
  await sandbox(async (dir) => {
    for (let i = 0; i < 12; i++) {
      const log = createLogger({ dir, maxRuns: 5 })
      await log.finish({ durationMs: 1, outcome: 'x' })
    }
    const files = await readdir(join(dir, 'runs'))
    assert.equal(files.length, 5, 'summaries must not accumulate without bound')
  })
})

test('pruning keeps the newest summaries', async () => {
  await sandbox(async (dir) => {
    // Ids sort by their time prefix, so the newest files sort last.
    const ids = []
    for (let i = 0; i < 6; i++) {
      const log = createLogger({ dir, maxRuns: 2 })
      ids.push(log.runId)
      await log.finish({ durationMs: 1 })
      // Ensure a distinct time prefix.
      await new Promise((r) => setTimeout(r, 5))
    }
    const files = (await readdir(join(dir, 'runs'))).sort()
    assert.equal(files.length, 2)
    // The two newest ids must be the ones that survived.
    const survivors = files.map((f) => f.replace(/\.md$/, ''))
    assert.deepEqual(survivors, ids.slice(-2))
  })
})
