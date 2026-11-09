#!/usr/bin/env node
/**
 * Read a dsh-memory-dream event log.
 *
 * The JSONL is the source of truth; this is a convenience for the questions
 * that come up while improving the plugin. It reads only; it never writes.
 *
 *   node scripts/log-report.mjs <logDir>
 *   node scripts/log-report.mjs <logDir> --run <runId>
 *   node scripts/log-report.mjs <logDir> --type dream.material
 *   node scripts/log-report.mjs <logDir> --json
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

function usage(code = 0) {
  console.log(`usage: log-report.mjs <logDir> [options]

  --run <runId>     only events from one run
  --type <type>     only events of one type
  --json            print the filtered events as JSON
  --runs            list run ids with their event counts and duration
  --slow            list the slowest operations
`)
  process.exit(code)
}

const args = process.argv.slice(2)
if (args.length === 0 || args.includes('-h') || args.includes('--help')) usage()

const dir = args[0]
const opt = { run: null, type: null, json: false, runs: false, slow: false }
for (let i = 1; i < args.length; i++) {
  const a = args[i]
  if (a === '--run') opt.run = args[++i]
  else if (a === '--type') opt.type = args[++i]
  else if (a === '--json') opt.json = true
  else if (a === '--runs') opt.runs = true
  else if (a === '--slow') opt.slow = true
  else {
    console.error(`unknown option: ${a}`)
    usage(1)
  }
}

async function loadEvents() {
  let files
  try {
    files = (await readdir(dir)).filter((f) => f.startsWith('events.jsonl')).sort()
  } catch {
    console.error(`no log directory: ${dir}`)
    process.exit(1)
  }
  const events = []
  let skipped = 0
  for (const file of files) {
    const text = await readFile(join(dir, file), 'utf8')
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line))
      } catch {
        // A torn final line from a killed process is expected.
        skipped++
      }
    }
  }
  return { events, skipped, files }
}

const { events: all, skipped, files } = await loadEvents()

let events = all
if (opt.run) events = events.filter((e) => e.runId === opt.run)
if (opt.type) events = events.filter((e) => e.type === opt.type)

if (opt.json) {
  console.log(JSON.stringify(events, null, 2))
  process.exit(0)
}

if (opt.runs) {
  const byRun = new Map()
  for (const e of all) {
    if (!byRun.has(e.runId)) byRun.set(e.runId, { count: 0, first: e.ts, last: e.ts, types: new Set() })
    const r = byRun.get(e.runId)
    r.count++
    r.last = e.ts
    r.types.add(e.type)
  }
  console.log(`${byRun.size} run(s) across ${files.length} file(s), ${skipped} unreadable line(s)\n`)
  for (const [id, r] of byRun) {
    const ms = new Date(r.last) - new Date(r.first)
    const hasDream = r.types.has('dream.start')
    console.log(`${id}  ${String(r.count).padStart(4)} events  ${String(ms).padStart(6)}ms  ${hasDream ? 'dream' : 'session'}`)
  }
  process.exit(0)
}

if (opt.slow) {
  const timed = all.filter((e) => typeof e.ms === 'number').sort((a, b) => b.ms - a.ms).slice(0, 20)
  console.log('slowest operations:\n')
  for (const e of timed) {
    console.log(`${String(e.ms).padStart(7)}ms  ${e.type.padEnd(18)} ${e.ok === false ? 'FAILED ' : ''}${e.runId}`)
  }
  process.exit(0)
}

// Default: a compact timeline.
console.log(`${events.length} event(s) from ${files.length} file(s)`)
if (skipped) console.log(`(${skipped} unreadable line(s) skipped)`)
console.log('')

for (const e of events) {
  const time = e.ts.slice(11, 23)
  const ms = typeof e.ms === 'number' ? `${e.ms}ms` : ''
  const flag = e.ok === false ? ' FAIL' : ''
  const detail = summarise(e)
  console.log(`${time} ${e.type.padEnd(16)} ${ms.padStart(7)}${flag} ${detail}`)
}

/** One line of the fields that matter for that event type. */
function summarise(e) {
  switch (e.type) {
    case 'plugin.start':
      return `cap=${e.memoryCharLimit} lookback=${e.lookbackDays}d inject=${e.inject}`
    case 'memory.write':
      return `applied=${e.applied} entries=${e.entries} usage=${e.usage}${e.overCap ? ' OVER-CAP' : ''}`
    case 'note.append':
      return `date=${e.date} chars=${e.chars}`
    case 'wiki.read':
      return `${e.topic} found=${e.found}${e.blocked ? ' BLOCKED' : ''}`
    case 'wiki.write':
      return `${e.topic} chars=${e.chars}`
    case 'dream.start':
      return `date=${e.date} record=${e.wantRecord}`
    case 'dream.material':
      return (
        `memory=${e.memoryEntries}/${e.memoryChars}c notes=${e.notesRead} ` +
        `sessions=${e.sessionsRead} transcript=${e.transcriptChars}c ` +
        `ws=${e.workspaceMatched === false ? 'FELL-BACK' : 'ok'}` +
        (e.blockedEntries ? ` blocked=${e.blockedEntries}` : '')
      )
    case 'dream.record':
      return `chars=${e.chars} appended=${e.appended}`
    case 'dream.synthesis':
      return `chars=${e.chars}`
    case 'dream.end':
      return `record=${e.recordWritten} synthesis=${e.synthesisWritten}`
    case 'inject.render':
      return `chars=${e.chars} entries=${e.entries}`
    case 'audit':
      return `scanned=${e.scanned} findings=${e.findings} removed=${e.removed}`
    case 'lock.degraded':
      return `${e.reason}`
    default:
      return ''
  }
}
