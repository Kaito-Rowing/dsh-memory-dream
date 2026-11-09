/**
 * Local development telemetry.
 *
 * This is a debugging aid, not a product feature. It is off by default, it
 * writes outside the repository, and nothing it records is ever fed back into
 * the model.
 *
 * Design constraints, in priority order:
 *
 *  1. **It must never break the memory system.** Every call is wrapped: a
 *     logging failure returns a no-op and the caller continues. Telemetry that
 *     can lose a memory is worse than no telemetry.
 *  2. **It must not record content.** Events carry counts, durations, ids and
 *     outcomes. Never memory text, never conversation text, never a prompt.
 *     The one exception is an explicit `debug` mode that records lengths and
 *     hashes, still not text.
 *  3. **It must be cheap when off.** A disabled logger allocates nothing and
 *     returns a shared no-op object.
 *
 * Two outputs, because they answer different questions:
 *
 *  - `events.jsonl` — one JSON object per line, append-only, for `jq` and
 *    scripts. Machine-readable.
 *  - `runs/<runId>.md` — a human summary of one dream, written at the end.
 *    Readable.
 *
 * The run id ties them together: every event carries `runId`, so a dream can
 * be reconstructed by filtering the JSONL.
 */

import { appendFile, mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'

/** A logger that does nothing. Returned whenever telemetry is disabled. */
export const NOOP = Object.freeze({
  enabled: false,
  runId: null,
  event() {},
  child() {
    return NOOP
  },
  async finish() {},
  async flush() {},
})

/**
 * Resolve the log directory.
 *
 * Deliberately outside the repository: the default is under the DSH home, and
 * an explicit `logDir` wins. A path inside a git worktree is refused, because
 * the whole point is that these files cannot be committed by accident.
 */
export function resolveLogDir(config, memoryRoot) {
  const wanted = config.logDir
    ? config.logDir
    : join(memoryRoot, '..', '.dsh-memory-dream-logs')
  return wanted
}

/**
 * Refuse a log directory inside a git worktree.
 *
 * The .gitignore covers the default location, but a user who points `logDir`
 * at their checkout should be told rather than silently producing files that
 * `git add -A` would pick up.
 */
export async function assertOutsideGit(dir) {
  let current = dir
  for (let i = 0; i < 40; i++) {
    try {
      await stat(join(current, '.git'))
      return { ok: false, reason: `logDir is inside a git worktree: ${dir}` }
    } catch {
      // keep walking
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return { ok: true }
}

// ---------------------------------------------------------------- ids

const RUN_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/** A short, sortable-ish run id: time prefix plus randomness. */
export function newRunId(now = Date.now()) {
  const stamp = now.toString(36).padStart(9, '0')
  const bytes = randomBytes(4)
  let suffix = ''
  for (const b of bytes) suffix += RUN_ALPHABET[b % RUN_ALPHABET.length]
  return `run_${stamp}_${suffix}`
}

// ---------------------------------------------------------------- redaction

/**
 * Keys that must never be written, whatever a caller passes.
 *
 * This is a safety net, not the primary defence: callers are expected to pass
 * metadata only. It exists because a future caller will eventually pass a
 * whole object and this should stop the obvious leaks.
 *
 * Note what is NOT here: `entries`, `count`, `chars`, `lines`. Those are the
 * names the plugin uses for *counts*, and redacting them would hide the
 * numbers this module exists to record. The rule is about content, not about
 * words that happen to name a collection.
 */
const FORBIDDEN_KEYS = new Set([
  'text',
  'content',
  'prompt',
  'message',
  'messages',
  'body',
  'memory',
  'transcript',
  'synthesis',
  'record',
  'apiKey',
  'api_key',
  'token',
  'password',
  'secret',
  'credential',
  'authorization',
])

const MAX_STRING = 200
const MAX_ARRAY = 20
const MAX_DEPTH = 3

/**
 * Reduce a value to something safe to log.
 *
 * Strings are truncated, arrays capped, depth bounded, and forbidden keys are
 * replaced with a marker rather than dropped so a reader can see that
 * something was withheld and why.
 */
export function sanitize(value, depth = 0) {
  if (value === null || value === undefined) return value
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    return value.length <= MAX_STRING ? value : `${value.slice(0, MAX_STRING)}…`
  }
  if (depth >= MAX_DEPTH) return '[depth]'
  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ARRAY).map((v) => sanitize(v, depth + 1))
    return value.length > MAX_ARRAY ? [...head, `…${value.length - MAX_ARRAY} more`] : head
  }
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(k)) {
        out[k] = '[redacted]'
        continue
      }
      out[k] = sanitize(v, depth + 1)
    }
    return out
  }
  return String(value)
}

// ---------------------------------------------------------------- logger

const MAX_BYTES_DEFAULT = 8 * 1024 * 1024
const MAX_FILES_DEFAULT = 5

/**
 * Create a logger.
 *
 * @param {object} options
 * @param {string} options.dir        log directory
 * @param {boolean} [options.debug]   record extra fields (still no text)
 * @param {number} [options.maxBytes] rotate after this size
 * @param {number} [options.maxFiles] how many rotated files to keep
 * @param {string} [options.runId]    reuse an id (a child logger)
 * @param {object} [options.base]     fields added to every event
 */
export function createLogger({
  dir,
  debug = false,
  maxBytes = MAX_BYTES_DEFAULT,
  maxFiles = MAX_FILES_DEFAULT,
  runId = null,
  base = {},
  shared = null,
} = {}) {
  const id = runId ?? newRunId()
  const startedAt = Date.now()

  // A child shares the parent's write queue. Without this, `child.flush()`
  // would only wait for the child's own writes and a caller could observe a
  // half-written file — the exact race this whole module exists to avoid.
  const state = shared ?? {
    queue: Promise.resolve(),
    bytesWritten: 0,
    disabled: false,
    dir,
    maxBytes,
    maxFiles,
  }

  const file = () => join(state.dir, 'events.jsonl')
  const runFile = () => join(state.dir, 'runs', `${id}.md`)

  /** Append one line. Serialized through the shared queue. */
  function write(line) {
    if (state.disabled) return
    state.queue = state.queue
      .then(async () => {
        await mkdir(state.dir, { recursive: true })
        await appendFile(file(), line, { encoding: 'utf8', mode: 0o600 })
        state.bytesWritten += Buffer.byteLength(line)
        if (state.bytesWritten > state.maxBytes) await rotate()
      })
      .catch(() => {
        // A logging failure must never surface. Disable after the first one so
        // a broken path does not cost a syscall per event.
        state.disabled = true
      })
  }

  async function rotate() {
    try {
      const current = file()
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const target = `${current}.${stamp}`
      await rename(current, target).catch(() => {})
      state.bytesWritten = 0
      await pruneOld()
    } catch {
      // Rotation failure is not fatal.
    }
  }

  async function pruneOld() {
    try {
      const files = (await readdir(state.dir))
        .filter((f) => f.startsWith('events.jsonl.'))
        .sort()
      for (const stale of files.slice(0, Math.max(0, files.length - state.maxFiles))) {
        await unlink(join(state.dir, stale)).catch(() => {})
      }
    } catch {
      // Pruning failure is not fatal.
    }
  }

  const logger = {
    enabled: true,
    runId: id,
    debug,

    /** Record one event. Never throws. */
    event(type, fields = {}) {
      const record = {
        ts: new Date().toISOString(),
        runId: id,
        type,
        ...sanitize(base),
        ...sanitize(fields),
      }
      if (debug) record.debug = true
      let line
      try {
        line = `${JSON.stringify(record)}\n`
      } catch {
        // A circular structure in `fields` would throw here.
        line = `${JSON.stringify({ ts: record.ts, runId: id, type, error: 'unserializable' })}\n`
      }
      write(line)
    },

    /** A logger sharing this run id, write queue, and directory. */
    child(extra = {}) {
      return createLogger({
        dir: state.dir,
        debug,
        maxBytes: state.maxBytes,
        maxFiles: state.maxFiles,
        runId: id,
        base: { ...base, ...extra },
        shared: state,
      })
    },

    /** Write the human summary for this run. Never throws. */
    async finish(summary) {
      try {
        await mkdir(dirname(runFile()), { recursive: true })
        const body = renderSummary({ runId: id, startedAt, summary, debug })
        await writeFile(runFile(), body, { encoding: 'utf8', mode: 0o600 })
      } catch {
        // Summary failure is not fatal.
      }
    },

    /** Wait for queued writes. Never throws. */
    async flush() {
      try {
        await state.queue
      } catch {
        // ignore
      }
    },
  }

  return logger
}

// ---------------------------------------------------------------- summary

/**
 * Render the human-readable dream summary.
 *
 * Deliberately short: the JSONL has the detail, this is the page a person
 * reads to decide whether the dream did anything worth looking into.
 */
export function renderSummary({ runId, startedAt, summary, debug }) {
  const s = summary ?? {}
  const lines = [
    `# Dream run ${runId}`,
    '',
    `- started: ${new Date(startedAt).toISOString()}`,
    `- duration: ${s.durationMs ?? '?'} ms`,
    `- outcome: ${s.outcome ?? 'unknown'}`,
    '',
    '## Material',
    '',
    `- memory entries: ${s.memoryEntries ?? '?'} (${s.memoryChars ?? '?'} chars, cap ${s.memoryCap ?? '?'})`,
    `- notes read: ${s.notesRead ?? '?'}`,
    `- sessions read: ${s.sessionsRead ?? '?'} (${s.transcriptChars ?? '?'} chars)`,
    `- workspace filter: ${s.workspaceMatched === false ? 'matched nothing, fell back to all' : 'matched'}`,
    `- prior dreams read: ${s.priorDreams ?? '?'}`,
  ]

  if (s.blockedEntries) {
    lines.push(`- blocked entries: ${s.blockedEntries}`)
  }

  lines.push('', '## Result', '')
  lines.push(`- record written: ${s.recordWritten ? 'yes' : 'no'}`)
  if (s.recordAppended) lines.push('- appended to an existing record (second pass)')
  lines.push(`- synthesis updated: ${s.synthesisWritten ? 'yes' : 'no'}`)
  if (s.memoryOps) {
    lines.push(
      `- memory operations: ${s.memoryOps.applied ?? 0} applied, ${s.memoryOps.rejected ?? 0} rejected`,
    )
  }

  if (s.warnings?.length) {
    lines.push('', '## Warnings', '')
    for (const w of s.warnings) lines.push(`- ${w}`)
  }

  if (s.lockDegradations) {
    lines.push('', '## Lock', '', `- degraded ${s.lockDegradations} time(s)`)
  }

  lines.push('', '## Where to look', '')
  lines.push(`- events: \`events.jsonl\` filtered by \`runId == "${runId}"\``)
  if (debug) lines.push('- this run used debug mode: extra fields were recorded, still no text')

  return `${lines.join('\n')}\n`
}

// ---------------------------------------------------------------- helpers

/** Time an async function and record the outcome. Never throws from logging. */
export async function timed(logger, type, fn, fields = {}) {
  const start = Date.now()
  try {
    const result = await fn()
    logger.event(type, { ...fields, ok: true, ms: Date.now() - start })
    return result
  } catch (err) {
    logger.event(type, {
      ...fields,
      ok: false,
      ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}

/** Count occurrences of a string in a string, for size accounting. */
export function countLines(text) {
  if (!text) return 0
  let n = 1
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  return n
}
