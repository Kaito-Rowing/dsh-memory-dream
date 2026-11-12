import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const telemetryPath = join(here, '..', 'lib', 'telemetry.js')
const telemetryUrl = `file://${telemetryPath.replace(/\\/g, '/')}`

/**
 * Run one child process that writes N events through its own logger.
 *
 * Each child is a separate process with its own queue, which is the situation
 * two DSH profiles sharing a home would produce. The script is written to a
 * file rather than passed with `-e` because `process.argv` shifts under `-e`
 * and the arguments would land in the wrong slots.
 */
async function spawnWriter(dir, tag, count, extra = '') {
  const scriptPath = join(dir, `writer-${tag}-${Date.now()}.mjs`)
  const script = `
import { createLogger } from ${JSON.stringify(telemetryUrl)}
const log = createLogger({ dir: process.argv[2]${extra} })
for (let i = 0; i < ${count}; i++) {
  log.event('proc', { tag: ${JSON.stringify(tag)}, i, pad: 'x'.repeat(40) })
}
await log.flush()
`
  await writeFile(scriptPath, script, 'utf8')
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, dir], { stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}`))))
  })
}

async function sandbox(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'memdream-mp-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
  }
}

test('concurrent processes append without corrupting lines', async () => {
  await sandbox(async (dir) => {
    const perProcess = 40
    const processes = 3

    await Promise.all(
      Array.from({ length: processes }, (_, i) => spawnWriter(dir, `p${i}`, perProcess)),
    )

    const text = await readFile(join(dir, 'events.jsonl'), 'utf8')
    const lines = text.split('\n').filter(Boolean)
    assert.equal(
      lines.length,
      processes * perProcess,
      'every event from every process must land',
    )

    // O_APPEND makes each write atomic, so no line should be torn.
    let bad = 0
    const tags = new Map()
    for (const line of lines) {
      let e
      try {
        e = JSON.parse(line)
      } catch {
        bad++
        continue
      }
      tags.set(e.tag, (tags.get(e.tag) ?? 0) + 1)
    }
    assert.equal(bad, 0, 'no line may be torn by a concurrent writer')
    for (let i = 0; i < processes; i++) {
      assert.equal(tags.get(`p${i}`), perProcess, `process p${i} lost events`)
    }
  })
})

test('concurrent processes each keep their own run ids', async () => {
  await sandbox(async (dir) => {
    await Promise.all([spawnWriter(dir, 'a', 5), spawnWriter(dir, 'b', 5)])
    const text = await readFile(join(dir, 'events.jsonl'), 'utf8')
    const events = text.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const ids = new Set(events.map((e) => e.runId))
    assert.equal(ids.size, 2, 'two processes must not collide on a run id')
  })
})

test('a process writing while another rotates does not fail', async () => {
  await sandbox(async (dir) => {
    // A tiny cap forces rotation in the children.
    await Promise.all([
      spawnWriter(dir, 'a', 40, ', maxBytes: 2000, maxFiles: 3'),
      spawnWriter(dir, 'b', 40, ', maxBytes: 2000, maxFiles: 3'),
    ])

    const files = await readdir(dir)
    const rotated = files.filter((f) => f.startsWith('events.jsonl.'))
    assert.ok(rotated.length > 0, 'rotation must have happened')
    assert.ok(rotated.length <= 3, `kept ${rotated.length} rotated files, cap is 3`)

    // Whatever survived must still be valid JSON.
    let bad = 0
    for (const f of files.filter((x) => x.startsWith('events.jsonl'))) {
      const text = await readFile(join(dir, f), 'utf8')
      for (const line of text.split('\n').filter(Boolean)) {
        try {
          JSON.parse(line)
        } catch {
          bad++
        }
      }
    }
    assert.equal(bad, 0)
  })
})

test('two processes booting a fresh home do not clobber each other', async () => {
  // Regression: first-run initialization was check-then-write, so the slower
  // process could replace a MEMORY.md the faster one had just filled.
  const indexPath = join(here, '..', 'lib', 'index.js')
  const indexUrl = `file://${indexPath.replace(/\\/g, '/')}`
  const script = `
import { apply } from ${JSON.stringify(indexUrl)}
const [home, tag] = process.argv.slice(2)
process.env.DSH_HOME = home
const tools = new Map()
apply(
  { tools: { register: (t) => tools.set(t.name, t) } },
  {},
)
await tools.get('memory').execute(
  { operations: [{ action: 'add', content: 'from-' + tag }] },
  { signal: new AbortController().signal },
)
process.exit(0)
`

  await sandbox(async (dir) => {
    for (let round = 0; round < 3; round++) {
      const home = join(dir, `home-${round}`)
      const scriptPath = join(dir, `boot-${round}.mjs`)
      await writeFile(scriptPath, script, 'utf8')

      const run = (tag) =>
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [scriptPath, home, tag], { stdio: 'inherit' })
          child.on('error', reject)
          child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`child ${tag} exited ${code}`))))
        })
      await Promise.all([run('a'), run('b')])

      const text = await readFile(join(home, 'memory', 'MEMORY.md'), 'utf8')
      assert.match(text, /from-[ab]/, 'initialization must not leave an empty memory behind')
    }
  })
})

test('a process never observes a half-written initial MEMORY.md', async () => {
  // Regression: creating the destination with 'wx' and writing into it
  // exposed an empty file to the loser of the create race, which then treated
  // initialization as complete and read a partial document.
  const indexPath = join(here, '..', 'lib', 'index.js')
  const indexUrl = `file://${indexPath.replace(/\\/g, '/')}`

  // B waits for the file to appear and reports what it saw the moment it did.
  const reader = `
import { apply } from ${JSON.stringify(indexUrl)}
const [home] = process.argv.slice(2)
process.env.DSH_HOME = home
const { readFile } = await import('node:fs/promises')
const { join } = await import('node:path')
const file = join(home, 'memory', 'MEMORY.md')
const deadline = Date.now() + 5000
let seen = null
while (Date.now() < deadline) {
  try {
    seen = await readFile(file, 'utf8')
    break
  } catch {
    await new Promise((r) => setTimeout(r, 1))
  }
}
if (seen === null) { console.log('NEVER'); process.exit(0) }
console.log(seen.length === 0 ? 'EMPTY' : seen.startsWith('# MEMORY.md') ? 'COMPLETE' : 'PARTIAL')
process.exit(0)
`

  await sandbox(async (dir) => {
    for (let round = 0; round < 5; round++) {
      const home = join(dir, `home-${round}`)
      const scriptPath = join(dir, `reader-${round}.mjs`)
      await writeFile(scriptPath, reader, 'utf8')

      const spawnReader = () =>
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [scriptPath, home], { stdio: ['ignore', 'pipe', 'inherit'] })
          let out = ''
          child.stdout.on('data', (d) => (out += d))
          child.on('error', reject)
          child.on('exit', () => resolve(out.trim()))
        })

      const writer = `
import { apply } from ${JSON.stringify(indexUrl)}
process.env.DSH_HOME = ${JSON.stringify(home)}
apply({ tools: { register: () => {} } }, {})
await new Promise((r) => setTimeout(r, 200))
process.exit(0)
`
      const writerPath = join(dir, `writer-${round}.mjs`)
      await writeFile(writerPath, writer, 'utf8')

      const [observed] = await Promise.all([
        spawnReader(),
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [writerPath], { stdio: 'inherit' })
          child.on('error', reject)
          child.on('exit', resolve)
        }),
      ])

      assert.notEqual(observed, 'EMPTY', 'the destination must never be visible empty')
      assert.notEqual(observed, 'PARTIAL', 'the destination must never be visible half-written')
    }
  })
})
