/**
 * Reading session transcripts for the dream.
 *
 * The dream's whole value comes from checking memory against what was
 * actually said. Without transcripts it can only compare notes to memory,
 * which is comparing two summaries of the same conversation — that catches
 * drift, not error.
 *
 * DSH stores sessions as multi-frame zstd JSONL under
 * `$DSH_HOME/sessions/<encoded-cwd>/<session-id>/session.vN.jsonl.zstd`.
 * The format is documented as append-only with generation selection; this
 * reader is deliberately conservative:
 *
 *  - It never writes, never migrates, and never opens the newest generation
 *    for update.
 *  - It reads the highest-numbered generation it can find.
 *  - A frame that fails to decompress is skipped, not fatal: a partially
 *    written tail is normal for a live session.
 *
 * The session-query service (`ctx.sessionQuery`) offers a supported API for
 * the same data, but this reader does not use it: it reads the filesystem
 * directly so that the dream works in compositions that do not mount the
 * service, and so that the reader is testable without one. The trade is that
 * a future storage-format change needs a matching update here.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { dshHome } from './paths.js'

/**
 * zstd decompression is a Node 22.15+ API.
 *
 * It is loaded through `require` rather than a static `import` because a named
 * import of a missing export fails at module-instantiation time — the whole
 * plugin would refuse to load on Node 20 instead of degrading to "no
 * transcripts". `require` returns the module object, so a missing function is
 * a runtime check rather than a link error.
 */
const zlib = createRequire(import.meta.url)('node:zlib')
const zstdDecompressSync = zlib.zstdDecompressSync

/** Whether this runtime can decompress zstd. */
export const ZSTD_AVAILABLE = typeof zstdDecompressSync === 'function'

const SESSION_FILE_RE = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/

/** Locate the newest generation of one session's log. */
function pickGeneration(files) {
  let best = null
  for (const name of files) {
    const m = SESSION_FILE_RE.exec(name)
    if (!m) continue
    const version = m[1] ? Number(m[1]) : 0
    const compressed = name.endsWith('.zstd')
    // Prefer the highest version; within a version prefer the compressed file.
    if (
      !best ||
      version > best.version ||
      (version === best.version && compressed && !best.compressed)
    ) {
      best = { name, version, compressed }
    }
  }
  return best
}

/**
 * Decompress a multi-frame zstd buffer.
 *
 * DSH appends one zstd frame per flush. `zstdDecompressSync` stops after the
 * first frame, so the buffer is split on the frame magic and decompressed
 * frame by frame. A frame that fails is skipped; a live session can end with
 * a partial frame.
 */
export function decompressFrames(buf) {
  if (!ZSTD_AVAILABLE) {
    throw new Error(
      'zstd decompression needs Node 22.15 or newer; this runtime cannot read session transcripts',
    )
  }
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (
      buf[i] === MAGIC[0] &&
      buf[i + 1] === MAGIC[1] &&
      buf[i + 2] === MAGIC[2] &&
      buf[i + 3] === MAGIC[3]
    ) {
      starts.push(i)
    }
  }
  if (starts.length === 0) {
    // Not a zstd file, or a single frame without a recognizable magic.
    try {
      return zstdDecompressSync(buf).toString('utf8')
    } catch {
      return ''
    }
  }

  const out = []
  for (let k = 0; k < starts.length; k++) {
    const start = starts[k]
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    try {
      out.push(zstdDecompressSync(buf.subarray(start, end)).toString('utf8'))
    } catch {
      // Partial or corrupt frame: skip it.
    }
  }
  return out.join('')
}

/** Parse JSONL text into events, skipping malformed lines. */
export function parseEvents(text) {
  const events = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      // A truncated final line is expected for a session that is still open.
    }
  }
  return events
}

/** Text of a message event's content blocks. */
function messageText(event) {
  const content = event?.data?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/**
 * Reduce events to a readable conversation.
 *
 * Only user and assistant text is kept. Tool calls, results, system messages
 * and injected context are dropped: the dream is checking what was *said*,
 * and tool output is exactly the untrusted material that should not be
 * re-presented as evidence.
 */
export function toConversation(events) {
  const turns = []
  for (const event of events) {
    if (event?.type === 'user/message') {
      const text = messageText(event).trim()
      if (!text) continue
      // Skip injected context: approval notices, runtime facts, plugin notes.
      const source = event?.data?.source?.kind
      if (source && source !== 'user') continue
      turns.push({ role: 'user', text })
    } else if (event?.type === 'assistant/message') {
      const text = messageText(event).trim()
      if (!text) continue
      turns.push({ role: 'assistant', text })
    }
  }
  return turns
}

/** List session directories under the sessions root. */
async function listSessionDirs(root) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const dirs = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const workspaceDir = join(root, entry.name)
    let children
    try {
      children = await readdir(workspaceDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of children) {
      if (!child.isDirectory()) continue
      dirs.push({ workspace: entry.name, sessionId: child.name, dir: join(workspaceDir, child.name) })
    }
  }
  return dirs
}

/**
 * Read recent sessions.
 *
 * @param {object} options
 * @param {string} options.since         oldest date to include, `YYYY-MM-DD`
 * @param {string} [options.workspace]   restrict to one encoded workspace dir
 * @param {number} [options.maxChars]    total text budget
 * @param {number} [options.maxSessions] session count cap
 * @param {boolean} [options.fallbackToAll]  when the workspace filter matches
 *   nothing, retry without it (default false; explicit opt-in only)
 * @returns {Promise<{ sessions: object[], truncated: boolean, workspaceMatched?: boolean, fallbackToAllUsed?: boolean }>}
 */
export async function readRecentSessions({
  since,
  workspace,
  maxChars = 40000,
  maxSessions = 20,
  home = dshHome(),
  fallbackToAll = false,
} = {}) {
  if (!ZSTD_AVAILABLE) {
    return {
      sessions: [],
      truncated: false,
      unavailable: 'zstd decompression needs Node 22.15 or newer',
    }
  }

  const first = await collect({ since, workspace, maxChars, maxSessions, home })

  // Never silently broaden a workspace-scoped request into other projects.
  // An empty result is safer than leaking unrelated conversations into the
  // agent's model context. Explicit callers may opt into the old behavior.
  if (workspace && first.sessions.length === 0) {
    if (fallbackToAll) {
      const all = await collect({ since, workspace: undefined, maxChars, maxSessions, home })
      if (all.sessions.length > 0) {
        return { ...all, workspaceMatched: false, fallbackToAllUsed: true }
      }
    }
    return { ...first, workspaceMatched: false, fallbackToAllUsed: false }
  }

  return { ...first, workspaceMatched: true, fallbackToAllUsed: false }
}

/** One pass over the session tree, optionally filtered by workspace. */
async function collect({ since, workspace, maxChars, maxSessions, home }) {
  const root = join(home, 'sessions')
  const dirs = await listSessionDirs(root)

  // Newest first by the log's mtime.
  const candidates = []
  for (const entry of dirs) {
    if (workspace && entry.workspace !== workspace) continue
    let files
    try {
      files = await readdir(entry.dir)
    } catch {
      continue
    }
    const gen = pickGeneration(files)
    if (!gen) continue
    const file = join(entry.dir, gen.name)
    let info
    try {
      info = await stat(file)
    } catch {
      continue
    }
    const date = new Date(info.mtimeMs).toISOString().slice(0, 10)
    if (since && date < since) continue
    candidates.push({ ...entry, file, date, mtime: info.mtimeMs })
  }

  candidates.sort((a, b) => b.mtime - a.mtime)

  const sessions = []
  let used = 0
  let truncated = false

  for (const candidate of candidates) {
    if (sessions.length >= maxSessions || used >= maxChars) {
      truncated = true
      break
    }
    let raw
    try {
      raw = await readFile(candidate.file)
    } catch {
      continue
    }
    let text
    try {
      text = candidate.file.endsWith('.zstd')
        ? decompressFrames(raw)
        : raw.toString('utf8')
    } catch {
      // A frame that cannot be decompressed means the log is unreadable, not
      // that the session was empty. Skip it rather than failing the dream.
      continue
    }
    const turns = toConversation(parseEvents(text))
    if (turns.length === 0) continue

    const rendered = turns.map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`).join('\n\n')
    const budget = maxChars - used
    const clipped = rendered.length > budget ? `${rendered.slice(0, budget)}\n[...truncated]` : rendered
    used += clipped.length
    sessions.push({
      sessionId: candidate.sessionId,
      workspace: candidate.workspace,
      date: candidate.date,
      turns: turns.length,
      chars: clipped.length,
      text: clipped,
    })
    if (clipped.length < rendered.length) {
      truncated = true
      break
    }
  }

  return { sessions, truncated }
}

/**
 * Encode a working directory the way DSH names its session directories.
 *
 * DSH replaces path separators and colons with `-`, collapses runs, and wraps
 * the result in `--`. An unrecognized encoding matches nothing by default;
 * it does not silently widen the search to unrelated workspaces.
 */
export function encodeWorkspace(cwd) {
  if (!cwd) return null
  const body = String(cwd)
    .replace(/[\\/:]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return `--${body}--`
}
