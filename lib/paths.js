/**
 * Filesystem layout and path validation.
 *
 * Every path the model can influence goes through a validator here. A tool
 * argument is model-generated text; it must never be able to reach outside
 * the memory root.
 */

import { join, resolve, sep, isAbsolute } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** The memory root for a given config. */
export function memoryRoot(config) {
  return config.memoryDir || join(dshHome(), 'memory')
}

/** Named locations under the memory root. */
export function layout(root) {
  return {
    root,
    memory: join(root, 'MEMORY.md'),
    notes: join(root, 'notes'),
    wiki: join(root, 'wiki'),
    dreams: join(root, 'dreams'),
    synthesis: join(root, 'dreams', 'SYNTHESIS.md'),
    state: join(root, '.state'),
  }
}

export async function ensureLayout(paths) {
  for (const dir of [paths.root, paths.notes, paths.wiki, paths.dreams, paths.state]) {
    await mkdir(dir, { recursive: true })
  }
}

// ---------------------------------------------------------------- validation

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Validate a `YYYY-MM-DD` date string and return it, or null.
 *
 * Rejects anything that is not a real calendar date, so `2026-02-30` and
 * `../../etc/passwd` both fail. The regex alone is not enough: a date-shaped
 * string can still name a nonexistent day.
 */
export function validDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return null
  const [y, m, d] = value.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null
  }
  return value
}

/** Today's date in local time, as `YYYY-MM-DD`. */
export function today(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/** A date N days before `from`, as `YYYY-MM-DD`. */
export function daysBefore(from, days) {
  const dt = new Date(`${from}T00:00:00Z`)
  dt.setUTCDate(dt.getUTCDate() - days)
  return dt.toISOString().slice(0, 10)
}

const TOPIC_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * Validate a wiki topic name.
 *
 * Kebab-case only: no dots, no slashes, no leading hyphen. This is stricter
 * than the filesystem requires because the topic becomes a filename and the
 * model chooses it.
 */
export function validTopic(value) {
  if (typeof value !== 'string') return null
  const t = value.trim()
  return TOPIC_RE.test(t) ? t : null
}

/**
 * Resolve `child` under `parent` and confirm it stays there.
 *
 * Belt and braces: the callers already validate their inputs, but a future
 * caller that forgets should not be able to escape the root.
 */
export function confine(parent, child) {
  const base = resolve(parent)
  const target = resolve(base, child)
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`path escapes the memory root: ${child}`)
  }
  return target
}

/** Reject absolute paths and traversal in a user-supplied relative path. */
export function safeRelative(value) {
  if (typeof value !== 'string' || !value) return null
  if (isAbsolute(value)) return null
  const normalized = value.replace(/\\/g, '/')
  if (normalized.split('/').some((seg) => seg === '..')) return null
  return normalized
}
