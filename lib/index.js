/**
 * dsh-memory-dream — layered agent memory for DeepSeek Harness.
 *
 * The hierarchy, smallest and most expensive first:
 *
 *   injected   MEMORY.md            index only, hard cap, read every turn
 *   wiki       wiki/<topic>.md      detail, one topic per page
 *   notes      notes/YYYY-MM-DD.md  raw day-to-day
 *   evidence   ~/.dsh/sessions/     the conversation itself
 *
 * plus two dream artifacts:
 *
 *   dreams/YYYY-MM-DD.md   history, appended to, never rewritten
 *   dreams/SYNTHESIS.md    current guidance, rewritten freely
 *
 * Two ideas carry the design:
 *
 *  1. The cap is a forcing function. A write that would exceed it is rejected
 *     and every current entry is returned, so the agent has to consolidate in
 *     one batch. An agent that never hits the cap never merges anything.
 *
 *  2. The dream corrects against evidence. It reads the actual conversation,
 *     not just the agent's own notes, and when it cannot decide between two
 *     claims it records the conflict instead of picking one.
 */

import { readdir } from 'node:fs/promises'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { resolveConfig } from './config.js'
import {
  memoryRoot,
  layout,
  ensureLayout,
  validDate,
  validTopic,
  today as todayDate,
  daysBefore,
  confine,
} from './paths.js'
import { readText, writeTextAtomic, appendText } from './store.js'
import { parseMemory, renderMemory, charCount, DEFAULT_HEADER } from './memory.js'
import { scan, guard, blockedMarker } from './scan.js'
import {
  buildMaterial,
  writeDreamRecord,
  writeSynthesis,
  withMemoryLock,
} from './dream.js'

export const name = 'memory-dream'
// Only `tools` is required. `systemPrompt` is deliberately NOT declared here:
// Cordis treats a declared service as mandatory for activation, so a
// composition without `dsh-system-prompt` (headless, for one) would fail to
// load the plugin entirely. The injection block below reads the service
// defensively and reports through `memory_status` when it is absent.
export const inject = ['tools']

// ---------------------------------------------------------------- messages

const TEXT = {
  en: {
    memoryDesc:
      'Manage persistent memory. MEMORY.md is the index of what is currently true; it has a hard ' +
      'character cap. A write that would exceed the cap is rejected and every current entry is ' +
      'returned, so consolidate in a single operations batch: remove or shorten stale entries and ' +
      'add the new one together. Put detail in memory_wiki and day-to-day context in memory_note.',
    noteDesc:
      'Append to a dated working note. This is where detail that does not belong in MEMORY.md goes: ' +
      'reasoning, dead ends, context. The dream reads these alongside the conversation.',
    wikiDesc:
      'Read or write a topic page. Wiki pages hold the detail that MEMORY.md only points at. ' +
      'Omit content to read. Writing replaces the whole page, so read first.',
    dreamDesc:
      'Assemble dream material: current memory, the actual conversation transcripts, the notes, and ' +
      'prior dreams. Verify what is written rather than generating new facts. When the evidence ' +
      'cannot settle a disagreement, record the conflict instead of choosing.',
    dreamWriteDesc:
      'The dream record for this date. Written once; a second run appends rather than replaces.',
    synthesisDesc:
      'New full text for SYNTHESIS.md, the current guidance. Omit to leave it unchanged.',
    statusDesc: 'Show the memory hierarchy: usage, counts, and what exists.',
    auditDesc:
      'Scan every memory layer for injection patterns. Blocked entries are replaced by a marker ' +
      'when injected, but the original text stays on disk; this shows it. Use fix to remove ' +
      'flagged MEMORY.md entries.',
    statusHeader: 'Memory hierarchy',
    auditClean: (n) => `memory_audit: scanned ${n} item(s), nothing flagged`,
    auditFound: (n, m) => `memory_audit: ${m} of ${n} item(s) flagged`,
    auditRemoved: (n) => `Removed ${n} MEMORY.md entr(y/ies)`,
    auditReadOnly: 'Inspection only. Pass fix: true to remove flagged MEMORY.md entries.',
  },
  ja: {
    memoryDesc:
      '永続記憶を管理する。MEMORY.md は「今の真実」の索引で、文字数上限がある。' +
      '上限を超える書き込みは受け付けず、現在の全エントリを返す。1 回の operations バッチで、' +
      '古いエントリを削るか短くしてから新しいものを足すこと。' +
      '詳細は memory_wiki、日々の経緯は memory_note に書く。',
    noteDesc:
      '日付つきの作業ノートに追記する。MEMORY.md に置かない詳細（思考過程、行き止まり、経緯）の場所。' +
      '夢はこれを会話ログと突き合わせて読む。',
    wikiDesc:
      'トピックページを読み書きする。MEMORY.md が指すだけの詳細を置く。' +
      'content を省略すると読み取り。書き込みは全文置換なので、先に読むこと。',
    dreamDesc:
      '夢の材料を組み立てる。現在の記憶、実際の会話ログ、ノート、過去の夢。' +
      '新しい事実を作るのではなく、書かれていることを検証する。' +
      '証拠で決着できない食い違いは、勝手に決めずに矛盾として記録する。',
    dreamWriteDesc: 'この日の夢の記録。一度書いたら、2 回目は追記になる。',
    synthesisDesc: 'SYNTHESIS.md（現在の指針）の新しい全文。省略すると変更しない。',
    statusDesc: '記憶階層の状態を表示する。使用量、件数、何があるか。',
    auditDesc:
      '全記憶層の注入パターン検査。注入時にブロックされたエントリは印に差し替わるが、' +
      '元の文はディスクに残る。ここで確認できる。fix で MEMORY.md の該当エントリを削除する。',
    statusHeader: '記憶階層',
    auditClean: (n) => `memory_audit: ${n} 件を検査、問題なし`,
    auditFound: (n, m) => `memory_audit: ${n} 件中 ${m} 件に検出`,
    auditRemoved: (n) => `MEMORY.md から ${n} 件を削除しました`,
    auditReadOnly: '検査のみ。fix: true で MEMORY.md の該当エントリを削除します。',
  },
}

// ---------------------------------------------------------------- helpers

function preview(text, n = 60) {
  const one = String(text).replace(/\s+/g, ' ').trim()
  return one.length <= n ? one : `${one.slice(0, n)}…`
}

/** Resolve the date argument or fail with a clear message. */
function resolveDate(raw, fallbackToday = true) {
  if (raw === undefined || raw === null || raw === '') {
    return fallbackToday ? todayDate() : null
  }
  const d = validDate(String(raw))
  if (!d) {
    throw new Error(
      `invalid date ${JSON.stringify(raw)}: expected a real calendar date as YYYY-MM-DD`,
    )
  }
  return d
}

/**
 * Read a Cordis service without throwing.
 *
 * Cordis throws when a plugin reads a service it did not declare in `inject`,
 * and declaring one makes it mandatory for activation. Some services are
 * genuinely optional — `systemPrompt` is absent in a headless composition —
 * so the lookup is guarded instead of declared.
 */
function safeService(ctx, name) {
  try {
    return ctx[name]
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------- plugin

export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  const root = memoryRoot(config)
  const paths = layout(root)
  const t = TEXT[config.language] ?? TEXT.en

  // Set by the injection block below, called after every successful write so
  // the next turn sees the new memory without waiting for the mtime check.
  let injectionInvalidate = () => {}

  // Create the store eagerly, but never let a failure escape as an unhandled
  // rejection: the tools await `ready` themselves, and a caller that never
  // touches the plugin should not see an async error it cannot attribute.
  const ready = ensureLayout(paths)
    .then(async () => {
      if (!existsSync(paths.memory)) {
        await writeTextAtomic(paths.memory, renderMemory({ header: DEFAULT_HEADER, entries: [] }))
      }
    })
    .catch(() => {
      // Deferred: the first tool call retries and reports the real error.
    })

  const load = async () => {
    await ready
    return parseMemory(await readText(paths.memory))
  }

  // ------------------------------------------------------------ memory

  const memoryTool = defineTool({
    name: 'memory',
    description: t.memoryDesc,
    parameters: {
      operations: {
        type: 'array',
        required: true,
        description: 'Operations to apply. The cap is checked against the batch result.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string', required: true, description: 'add | patch | remove' },
            content: { type: 'string', description: 'add: full text. patch: replacement text.' },
            old_text: {
              type: 'string',
              description: 'patch / remove: a substring that identifies exactly one entry.',
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean' },
          usage: { type: 'string' },
          count: { type: 'number' },
          error: { type: 'string' },
          current_entries: { type: 'array', items: { type: 'string' } },
          applied: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_a, v) => {
        if (v.success) {
          return [
            {
              type: 'text',
              text: `memory: ${v.applied?.length ?? 0} applied (${v.usage}, ${v.count} entries)`,
            },
          ]
        }
        const lines = [`memory: rejected — ${v.error}`]
        if (v.current_entries?.length) {
          lines.push('', 'Current entries (remove or shorten from these):')
          v.current_entries.forEach((e, i) => lines.push(`${i + 1}. ${e}`))
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      return withMemoryLock(paths, async () => {
        const parsed = await load()
        const entries = [...parsed.entries]
        const applied = []

        const fail = (error) => ({
          success: false,
          error,
          usage: `${charCount(parsed.entries)}/${config.memoryCharLimit}`,
          count: parsed.entries.length,
          current_entries: parsed.entries,
          applied: [],
        })

        for (const op of args.operations ?? []) {
          const action = String(op.action ?? '')
          const content = String(op.content ?? '').trim()
          const oldText = String(op.old_text ?? '').trim()

          if (action === 'add') {
            if (!content) return fail('add requires content')
            if (entries.includes(content)) {
              applied.push('add: identical entry already present, skipped')
              continue
            }
            entries.push(content)
            applied.push(`add: ${preview(content)}`)
            continue
          }

          if (action === 'patch' || action === 'remove') {
            if (!oldText) return fail(`${action} requires old_text`)
            const hits = entries.map((e, i) => ({ e, i })).filter(({ e }) => e.includes(oldText))
            if (hits.length === 0) return fail(`no entry contains ${JSON.stringify(oldText)}`)
            if (hits.length > 1) {
              return fail(
                `old_text matches ${hits.length} entries; use a longer, unique substring`,
              )
            }
            const { i } = hits[0]
            if (action === 'remove') {
              applied.push(`remove: ${preview(entries[i])}`)
              entries.splice(i, 1)
            } else {
              if (!content) return fail('patch requires content')
              applied.push(`patch: ${preview(entries[i])} -> ${preview(content)}`)
              entries[i] = content
            }
            continue
          }

          return fail(`unknown action ${JSON.stringify(action)}`)
        }

        const used = charCount(entries)
        if (used > config.memoryCharLimit) {
          const over = used - config.memoryCharLimit
          return fail(
            `MEMORY.md would exceed its limit (${used}/${config.memoryCharLimit} chars, ` +
              `${over} over). Retry as ONE operations batch that removes or shortens stale ` +
              `entries from current_entries and adds the new one — the limit is checked only ` +
              `against the batch result.`,
          )
        }

        await writeTextAtomic(paths.memory, renderMemory({ header: parsed.header, entries }))
        injectionInvalidate()
        return {
          success: true,
          usage: `${used}/${config.memoryCharLimit}`,
          count: entries.length,
          applied,
        }
      })
    },
  })

  // ------------------------------------------------------------ note

  const noteTool = defineTool({
    name: 'memory_note',
    description: t.noteDesc,
    parameters: {
      text: { type: 'string', required: true, description: 'Markdown to append.' },
      date: { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { path: { type: 'string' }, ok: { type: 'boolean' }, date: { type: 'string' } },
      },
      render: (_a, v) => [{ type: 'text', text: `note: ${v.path}` }],
    },
    async execute(args) {
      await ready
      const date = resolveDate(args.date)
      const file = confine(paths.notes, `${date}.md`)
      const exists = existsSync(file)
      const body = exists ? `\n\n${String(args.text).trim()}\n` : `# ${date}\n\n${String(args.text).trim()}\n`
      await appendText(file, body)
      return { ok: true, path: file, date }
    },
  })

  // ------------------------------------------------------------ wiki

  const wikiTool = defineTool({
    name: 'memory_wiki',
    description: t.wikiDesc,
    parameters: {
      topic: {
        type: 'string',
        required: true,
        description: 'Kebab-case topic name, e.g. "deploy-pipeline".',
      },
      content: { type: 'string', description: 'New full page text. Omit to read.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          topic: { type: 'string' },
          path: { type: 'string' },
          content: { type: 'string' },
          written: { type: 'boolean' },
          topics: { type: 'array', items: { type: 'string' } },
          blocked: { type: 'boolean' },
        },
      },
      render: (_a, v) => [
        {
          type: 'text',
          text: v.written
            ? `wiki: wrote ${v.topic} (${v.content.length} chars)`
            : v.content
              ? `wiki: ${v.topic}\n\n${v.content}`
              : `wiki: topics — ${(v.topics ?? []).join(', ') || '(none)'}`,
        },
      ],
    },
    async execute(args) {
      await ready
      const topic = validTopic(args.topic)
      if (!topic) {
        throw new Error('topic must be kebab-case: lowercase letters, digits, hyphens')
      }
      const file = confine(paths.wiki, `${topic}.md`)

      if (args.content === undefined) {
        const raw = await readText(file, '')
        if (!raw) {
          let files = []
          try {
            files = await readdir(paths.wiki)
          } catch {
            files = []
          }
          return {
            topic,
            path: file,
            content: '',
            written: false,
            topics: files.filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')),
            blocked: false,
          }
        }
        // Reading is an injection path too: a wiki page is memory the agent
        // will act on. Scan it like MEMORY.md.
        const g = guard(raw, `wiki/${topic}.md`, config.scanInjection)
        return { topic, path: file, content: g.text, written: false, blocked: g.blocked }
      }

      const content = String(args.content).trim()
      await writeTextAtomic(file, `# ${topic}\n\n${content}\n`)
      injectionInvalidate()
      return { topic, path: file, content, written: true, blocked: false }
    },
  })

  // ------------------------------------------------------------ dream

  const dreamTool = defineTool({
    name: 'memory_dream',
    description: t.dreamDesc,
    parameters: {
      date: { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' },
      record: { type: 'string', description: t.dreamWriteDesc },
      synthesis: { type: 'string', description: t.synthesisDesc },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          date: { type: 'string' },
          material: { type: 'string' },
          dream_path: { type: 'string' },
          record_written: { type: 'boolean' },
          record_appended: { type: 'boolean' },
          synthesis_written: { type: 'boolean' },
          memory_usage: { type: 'string' },
          sessions_read: { type: 'number' },
          transcript_error: { type: 'string' },
        },
      },
      render: (_a, v) => {
        const lines = [v.material]
        if (v.record_written) {
          lines.push('', `---`, `Dream record ${v.record_appended ? 'appended to' : 'written to'} ${v.dream_path}`)
        }
        if (v.synthesis_written) lines.push('SYNTHESIS.md updated.')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      await ready
      const date = resolveDate(args.date)
      const workspace = config.transcriptsSameWorkspace ? process.cwd() : undefined

      const built = await buildMaterial({
        paths,
        config,
        date,
        workspace,
        sessionQuery: ctx.get?.('sessionQuery'),
      })

      let recordWritten = false
      let recordAppended = false
      let dreamPath = join(paths.dreams, `${date}.md`)

      if (args.record !== undefined) {
        const body = String(args.record).trim()
        if (!body) throw new Error('record must not be empty')
        const res = await withMemoryLock(paths, () =>
          writeDreamRecord({ paths, date, body }),
        )
        recordWritten = true
        recordAppended = res.appended
        dreamPath = res.file
      }

      let synthesisWritten = false
      if (args.synthesis !== undefined) {
        const text = String(args.synthesis).trim()
        if (!text) throw new Error('synthesis must not be empty')
        await withMemoryLock(paths, () => writeSynthesis({ paths, text }))
        synthesisWritten = true
      }

      return {
        ok: true,
        date,
        material: built.material,
        dream_path: dreamPath,
        record_written: recordWritten,
        record_appended: recordAppended,
        synthesis_written: synthesisWritten,
        memory_usage: `${charCount(built.parsed.entries)}/${config.memoryCharLimit}`,
        sessions_read: built.transcript.sessions.length,
        transcript_error: built.transcript.error ?? '',
      }
    },
  })

  // ------------------------------------------------------------ status

  const statusTool = defineTool({
    name: 'memory_status',
    description: t.statusDesc,
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string' },
          memory_usage: { type: 'string' },
          memory_count: { type: 'number' },
          notes: { type: 'number' },
          wiki: { type: 'array', items: { type: 'string' } },
          dreams: { type: 'number' },
          synthesis_chars: { type: 'number' },
          injection: { type: 'string' },
        },
      },
      render: (_a, v) =>
        [
          {
            type: 'text',
            text: [
              `${t.statusHeader} — ${v.root}`,
              `  MEMORY.md   ${v.memory_usage} chars / ${v.memory_count} entries`,
              `  notes/      ${v.notes} files`,
              `  wiki/       ${v.wiki.length} pages${v.wiki.length ? ` (${v.wiki.join(', ')})` : ''}`,
              `  dreams/     ${v.dreams} files`,
              `  SYNTHESIS   ${v.synthesis_chars} chars`,
              `  injection   ${v.injection}`,
            ].join('\n'),
          },
        ],
    },
    async execute() {
      await ready
      const parsed = await load()
      const list = async (dir, filter) => {
        try {
          return (await readdir(dir)).filter(filter)
        } catch {
          return []
        }
      }
      const notes = await list(paths.notes, (f) => f.endsWith('.md'))
      const wiki = (await list(paths.wiki, (f) => f.endsWith('.md'))).map((f) => f.replace(/\.md$/, ''))
      const dreams = await list(paths.dreams, (f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      const synthesis = await readText(paths.synthesis, '')
      return {
        root: paths.root,
        memory_usage: `${charCount(parsed.entries)}/${config.memoryCharLimit}`,
        memory_count: parsed.entries.length,
        notes: notes.length,
        wiki,
        dreams: dreams.length,
        synthesis_chars: synthesis.length,
        injection: injectionState.available
          ? `on (${injectionState.lastRendered} chars rendered)`
          : `off — ${injectionState.reason}`,
      }
    },
  })

  // ------------------------------------------------------------ audit

  const auditTool = defineTool({
    name: 'memory_audit',
    description: t.auditDesc,
    parameters: {
      fix: { type: 'boolean', description: 'Remove flagged MEMORY.md entries.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          scanned: { type: 'number' },
          removed: { type: 'number' },
          findings: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                layer: { type: 'string' },
                file: { type: 'string' },
                severity: { type: 'string' },
                hits: { type: 'array', items: { type: 'string' } },
                preview: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_a, v) => {
        if (v.findings.length === 0) return [{ type: 'text', text: t.auditClean(v.scanned) }]
        const lines = [t.auditFound(v.scanned, v.findings.length)]
        for (const f of v.findings) {
          lines.push(`  [${f.layer}] ${f.file} — ${f.severity}: ${f.hits.join(', ')}`)
          lines.push(`    ${f.preview}`)
        }
        if (v.removed > 0) lines.push(t.auditRemoved(v.removed))
        else lines.push(t.auditReadOnly)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      await ready
      const findings = []
      let scanned = 0

      // MEMORY.md, entry by entry, with the option to remove.
      const parsed = await load()
      const keep = []
      let removed = 0
      parsed.entries.forEach((entry, i) => {
        scanned++
        const hits = scan(entry)
        if (hits.length === 0) {
          keep.push(entry)
          return
        }
        findings.push({
          layer: 'MEMORY.md',
          file: `entry ${i + 1}`,
          severity: hits.some((h) => h.severity === 'block') ? 'block' : 'flag',
          hits: hits.map((h) => h.id),
          preview: preview(entry, 100),
        })
        if (args.fix === true) removed++
        else keep.push(entry)
      })
      if (args.fix === true && removed > 0) {
        await withMemoryLock(paths, () =>
          writeTextAtomic(paths.memory, renderMemory({ header: parsed.header, entries: keep })),
        )
        injectionInvalidate()
      }

      // Other layers: report only, never auto-remove. A wiki page or a note is
      // the user's own record; deleting it silently would be worse than the
      // thing it is being flagged for.
      const layers = [
        ['wiki', paths.wiki, (f) => f.endsWith('.md')],
        ['notes', paths.notes, (f) => f.endsWith('.md')],
        ['dreams', paths.dreams, (f) => f.endsWith('.md')],
      ]
      for (const [layer, dir, filter] of layers) {
        let files = []
        try {
          files = (await readdir(dir)).filter(filter)
        } catch {
          continue
        }
        for (const file of files) {
          scanned++
          const body = await readText(join(dir, file), '')
          const hits = scan(body)
          if (hits.length === 0) continue
          findings.push({
            layer,
            file,
            severity: hits.some((h) => h.severity === 'block') ? 'block' : 'flag',
            hits: hits.map((h) => h.id),
            preview: preview(body, 100),
          })
        }
      }

      return { ok: findings.length === 0, scanned, removed, findings }
    },
  })

  ctx.tools.register(memoryTool)
  ctx.tools.register(noteTool)
  ctx.tools.register(wikiTool)
  ctx.tools.register(dreamTool)
  ctx.tools.register(statusTool)
  ctx.tools.register(auditTool)

  // ------------------------------------------------------------ injection

  // MEMORY.md is read every turn. This is the layer the whole hierarchy exists
  // to keep small, so it is injected as dynamic context rather than as a file
  // the agent has to remember to read.
  //
  // `PromptContext.text` is synchronous: assembly cannot await a provider. So
  // the rendered text is cached and refreshed whenever the store changes, and
  // the provider returns the cache. A cold cache renders on the spot from a
  // synchronous read.
  //
  // Whether injection is possible depends on the composition: a tree without
  // `dsh-system-prompt` has no `ctx.systemPrompt`. That is reported through
  // `memory_status` rather than guessed at, so a user who sees no memory in
  // the prompt can tell why.
  const injectionState = {
    available: false,
    reason: '',
    lastRendered: 0,
  }

  if (!config.inject) {
    injectionState.reason = 'disabled by config (inject: false)'
  } else {
    // Reading an undeclared service throws in Cordis, so the lookup itself is
    // guarded. A composition without `dsh-system-prompt` still loads the
    // plugin and keeps every tool; it just has no prompt to contribute to.
    const systemPrompt = safeService(ctx, 'systemPrompt')
    if (!systemPrompt || typeof systemPrompt.context !== 'function') {
      injectionState.reason =
        'this composition has no systemPrompt service; memory is reachable only through the tools'
    } else {
      injectionState.available = true
      let cached = ''
      let cacheValid = false

      const renderContext = () => {
        try {
          const raw = readFileSync(paths.memory, 'utf8')
          const parsed = parseMemory(raw)
          if (parsed.entries.length === 0) return ''

          const lines = parsed.entries.map((entry, i) => {
            const g = guard(entry, `MEMORY.md entry ${i + 1}`, config.scanInjection)
            return `- ${g.text}`
          })

          const parts = [
            '# Persistent memory',
            '',
            `MEMORY.md — ${charCount(parsed.entries)}/${config.memoryCharLimit} chars, ` +
              `${parsed.entries.length} entries. This is what you currently hold to be true; ` +
              `it is not new input.`,
            '',
            ...lines,
          ]

          if (config.injectTopics) {
            try {
              const files = readdirSync(paths.wiki).filter((f) => f.endsWith('.md'))
              if (files.length) {
                const topics = files.map((f) => f.replace(/\.md$/, '')).sort()
                parts.push(
                  '',
                  `wiki/ has ${topics.length} page(s): ${topics.join(', ')}. ` +
                    `Read one with memory_wiki before answering from memory about that topic.`,
                )
              }
            } catch {
              // No wiki yet.
            }
          }

          return parts.join('\n')
        } catch {
          // Injection must never break a turn.
          return ''
        }
      }

      systemPrompt.context({
        name: 'memory-dream:memory',
        order: 900,
        text: () => {
          if (!cacheValid) {
            cached = renderContext()
            cacheValid = true
            injectionState.lastRendered = cached.length
          }
          return cached
        },
      })

      // Every write path invalidates. An external edit is picked up on the next
      // render because the cache also checks the file's mtime.
      let lastMtime = 0
      const refreshIfChanged = () => {
        try {
          const mtime = statSync(paths.memory).mtimeMs
          if (mtime !== lastMtime) {
            lastMtime = mtime
            cacheValid = false
          }
        } catch {
          cacheValid = false
        }
      }
      try {
        ctx.on?.('agent/pre-step', refreshIfChanged)
      } catch {
        // No event bus in this composition.
      }

      injectionInvalidate = () => {
        cacheValid = false
      }
    }
  }
}
