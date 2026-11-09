/**
 * dsh-memory-dream — Anthropic の agent memory 階層を DSH に実装する。
 *
 *   注入層   $DSH_HOME/memory/MEMORY.md   (索引だけ。上限つき)
 *   ノート   $DSH_HOME/memory/notes/YYYY-MM-DD.md
 *   表現     $DSH_HOME/memory/wiki/<topic>.md
 *   履歴     $DSH_HOME/memory/dreams/YYYY-MM-DD.md
 *   指針     $DSH_HOME/memory/dreams/SYNTHESIS.md
 *
 * 中核は 2 つ:
 *   1. `memory` ツール — 上限を超えたらエラーで全エントリを返し、
 *      1 バッチでの統合を強制する (Hermes の 2,200 字制限と同じ機構)。
 *   2. 夜間 dream — トランスクリプトと突き合わせて「間違っていた記述」を直す。
 */

import { readFile, writeFile, mkdir, readdir, appendFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'memory-dream'
export const inject = ['tools']

// ---------------------------------------------------------------- config

const DEFAULTS = {
  /** 注入層の上限。ここを超えたら書き込みが拒否される。 */
  memoryCharLimit: 4000,
  /** dream が読むノートの日数。 */
  lookbackDays: 14,
  /** 記憶のルート。省略時は $DSH_HOME/memory。 */
  memoryDir: null,
  /** 注入スキャンを有効にするか。 */
  scanInjection: true,
}

let config = { ...DEFAULTS }

// ---------------------------------------------------------------- paths

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function memoryRoot() {
  return config.memoryDir || join(dshHome(), 'memory')
}

const paths = {
  root: memoryRoot,
  memory: () => join(memoryRoot(), 'MEMORY.md'),
  notes: () => join(memoryRoot(), 'notes'),
  wiki: () => join(memoryRoot(), 'wiki'),
  dreams: () => join(memoryRoot(), 'dreams'),
  synthesis: () => join(memoryRoot(), 'dreams', 'SYNTHESIS.md'),
}

async function ensureDirs() {
  for (const d of [paths.root(), paths.notes(), paths.wiki(), paths.dreams()]) {
    await mkdir(d, { recursive: true })
  }
}

async function readText(file, fallback = '') {
  try {
    return await readFile(file, 'utf8')
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return fallback
    throw err
  }
}

async function writeText(file, text) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text, 'utf8')
}

// ---------------------------------------------------------------- injection scan

/**
 * 記憶ファイルを注入前にスキャンする。
 *
 * 記憶は「翌日の指示」として読まれる。夢が外部ページの文章を拾って
 * MEMORY.md に入れると、それが恒久的な命令になってしまう。
 * Hermes の _scan_context_content と同じ考え方で、ヒットしたら
 * 本文を差し替えて注入する（黙って通さない）。
 *
 * 過剰検知より「気づけること」を優先する。ブロックしたら理由を残す。
 */
const INJECTION_PATTERNS = [
  // 既存の指示を上書きしようとする
  { id: 'override', re: /\b(ignore|disregard|forget)\s+(all\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)/i },
  { id: 'override-ja', re: /(これまで|前述|上記|以前)の?(指示|命令|ルール|プロンプト)を(無視|忘れ|捨て)/ },
  // 役割の再定義
  { id: 'role', re: /\b(you\s+are\s+now|from\s+now\s+on\s+you\s+are|act\s+as\s+if\s+you\s+are)\b/i },
  { id: 'role-ja', re: /(あなたは(今から|今後)|これからは).{0,20}(として振る舞|になりき|演じ)/ },
  // システムプロンプトの露出要求
  { id: 'exfil-prompt', re: /\b(reveal|show|print|output|repeat)\s+(me\s+)?(your|the)\s+(system\s+)?(prompt|instructions)\b/i },
  // 秘密の持ち出し
  { id: 'exfil-secret', re: /\b(send|post|upload|exfiltrate|transmit)\b.{0,40}\b(api[_\s-]?key|password|token|credential|secret|\.env)\b/i },
  { id: 'exfil-secret-ja', re: /(apiキー|パスワード|トークン|認証情報|秘密鍵).{0,30}(送信|送って|アップロード|外部に)/ },
  // 権限の拡大を主張する
  { id: 'grant', re: /\b(you\s+(now\s+)?have\s+(full\s+)?permission|you\s+are\s+authorized\s+to|permission\s+(has\s+been|is)\s+granted)\b/i },
  // 不可視文字による偽装
  { id: 'invisible', re: /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/ },
]

function scanForInjection(text) {
  const hits = []
  for (const { id, re } of INJECTION_PATTERNS) {
    if (re.test(text)) hits.push(id)
  }
  return hits
}

/**
 * スキャンして、ヒットしたら差し替えた本文を返す。
 * `scanInjection: false` なら素通しする。
 */
function guardMemoryText(text, label) {
  if (!config.scanInjection) return { text, blocked: false, hits: [] }
  const hits = scanForInjection(text)
  if (hits.length === 0) return { text, blocked: false, hits: [] }
  return {
    text:
      `[BLOCKED: ${label} に注入パターン (${hits.join(', ')}) を検出しました。` +
      `本文は読み込んでいません。心当たりがなければ、この記憶を確認して削除してください。]`,
    blocked: true,
    hits,
  }
}

// ---------------------------------------------------------------- entries

const SEP = '\n§ '

/**
 * MEMORY.md をエントリ配列に分解する。
 * 先頭のヘッダ行 (`# MEMORY.md` など) は保持し、`§ ` 区切りの本体だけを扱う。
 */
function parseMemory(raw) {
  const text = raw.replace(/\r\n/g, '\n').trim()
  if (!text) return { header: '', entries: [] }

  // ヘッダ = 先頭から、最初の「実体行」より前までの # 見出しと <!-- --> ブロック。
  // 実体行 (エントリ) は § 区切りで、先頭が # でも <!-- でもない行から始まる。
  const lines = text.split('\n')
  const headerLines = []
  let i = 0
  let inComment = false

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    if (inComment) {
      headerLines.push(line)
      if (trimmed.includes('-->')) inComment = false
      i++
      continue
    }
    if (trimmed.startsWith('<!--')) {
      headerLines.push(line)
      if (!trimmed.includes('-->')) inComment = true
      i++
      continue
    }
    if (trimmed === '' || trimmed.startsWith('#')) {
      headerLines.push(line)
      i++
      continue
    }
    break
  }

  const body = lines.slice(i).join('\n').trim()
  const entries = body
    ? body
        .split(/\n§\s*/)
        .map((s) => s.replace(/^§\s*/, '').trim())
        .filter(Boolean)
    : []

  return { header: headerLines.join('\n').trim(), entries }
}

function renderMemory({ header, entries }) {
  const head = header || '# MEMORY.md\n\n<!-- 注入層。索引だけを置く。詳細は wiki/ と notes/ に。 -->'
  if (entries.length === 0) return `${head}\n`
  return `${head}\n\n${entries.join(SEP)}\n`
}

function charCount(entries) {
  // 区切りも含めた実バイトではなく、モデルが読む文字数で数える
  return entries.join(SEP).length
}

async function loadMemory() {
  await ensureDirs()
  return parseMemory(await readText(paths.memory()))
}

/**
 * 注入用に読む。エントリ単位でスキャンし、ヒットしたものだけ差し替える。
 * 汚染された 1 件のせいで記憶全体を失わないようにするため、
 * ファイル全体ではなくエントリごとに判定する。
 */
async function loadMemoryForInjection() {
  const parsed = await loadMemory()
  const blocked = []
  const entries = parsed.entries.map((entry) => {
    const g = guardMemoryText(entry, 'MEMORY.md')
    if (g.blocked) blocked.push({ entry, hits: g.hits })
    return g.text
  })
  return { header: parsed.header, entries, blocked }
}

async function saveMemory(parsed) {
  await writeText(paths.memory(), renderMemory(parsed))
}

// ---------------------------------------------------------------- tools

const memoryTool = defineTool({
  name: 'memory',
  description:
    '永続記憶を管理する。MEMORY.md は「今の真実」だけを置く索引で、上限がある。' +
    '上限を超える書き込みは拒否され、現在の全エントリが返るので、1 回の operations バッチで' +
    '古いエントリを削除/短縮してから追加すること。' +
    '詳細や経緯は memory_note / memory_wiki に書き、MEMORY.md には一行の索引だけを残す。',
  parameters: {
    operations: {
      type: 'array',
      required: true,
      description: '適用する操作のリスト。上限はバッチ全体の結果に対して判定される。',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            required: true,
            description: 'add | patch | remove',
          },
          content: {
            type: 'string',
            description: 'add: 追加する全文。patch: 置換後の全文。remove では不要。',
          },
          old_text: {
            type: 'string',
            description: 'patch / remove で対象を一意に特定する部分文字列。',
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
    render: (_args, value) => {
      if (value.success) {
        return [
          {
            type: 'text',
            text: `memory: ${value.applied?.length ?? 0} 件適用 (${value.usage}, ${value.count} エントリ)`,
          },
        ]
      }
      const lines = [`memory: 失敗 — ${value.error}`]
      if (value.current_entries?.length) {
        lines.push('', '現在のエントリ (この中から削ってください):')
        value.current_entries.forEach((e, i) => lines.push(`${i + 1}. ${e}`))
      }
      return [{ type: 'text', text: lines.join('\n') }]
    },
  },
  async execute(args) {
    const parsed = await loadMemory()
    const entries = [...parsed.entries]
    const applied = []

    for (const op of args.operations) {
      const action = String(op.action || '')
      const content = String(op.content || '').trim()
      const oldText = String(op.old_text || '').trim()

      if (action === 'add') {
        if (!content) return fail('add には content が必要です', entries, parsed)
        if (entries.includes(content)) {
          applied.push('add: 既存と同一のためスキップ')
          continue
        }
        entries.push(content)
        applied.push(`add: ${preview(content)}`)
        continue
      }

      if (action === 'patch' || action === 'remove') {
        if (!oldText) return fail(`${action} には old_text が必要です`, entries, parsed)
        const hits = entries
          .map((e, idx) => ({ e, idx }))
          .filter(({ e }) => e.includes(oldText))
        if (hits.length === 0) {
          return fail(`old_text に一致するエントリがありません: ${oldText}`, entries, parsed)
        }
        if (hits.length > 1) {
          return fail(
            `old_text が ${hits.length} 件に一致しました。より長く一意な文字列を指定してください: ${oldText}`,
            entries,
            parsed,
          )
        }
        const { idx } = hits[0]
        if (action === 'remove') {
          applied.push(`remove: ${preview(entries[idx])}`)
          entries.splice(idx, 1)
        } else {
          if (!content) return fail('patch には content が必要です', entries, parsed)
          applied.push(`patch: ${preview(entries[idx])} → ${preview(content)}`)
          entries[idx] = content
        }
        continue
      }

      return fail(`未知の action: ${action}`, entries, parsed)
    }

    // 上限判定はバッチ全体の結果に対して行う
    const used = charCount(entries)
    if (used > config.memoryCharLimit) {
      const over = used - config.memoryCharLimit
      return fail(
        `MEMORY.md が上限を超えます (${used}/${config.memoryCharLimit} 字, ${over} 字超過)。` +
          `1 回の operations バッチで、下記の current_entries から古い/冗長なものを remove するか` +
          ` patch で短縮し、同時に新しいエントリを追加してください。上限はバッチの最終結果にだけ適用されます。`,
        parsed.entries,
        parsed,
      )
    }

    await saveMemory({ header: parsed.header, entries })
    return {
      success: true,
      usage: `${used}/${config.memoryCharLimit}`,
      count: entries.length,
      applied,
    }
  },
})

function preview(text, n = 60) {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length <= n ? one : `${one.slice(0, n)}…`
}

function fail(error, currentEntries, parsed) {
  return {
    success: false,
    error,
    usage: `${charCount(parsed.entries)}/${config.memoryCharLimit}`,
    count: parsed.entries.length,
    current_entries: currentEntries,
    applied: [],
  }
}

// ---------------------------------------------------------------- note / wiki

const noteTool = defineTool({
  name: 'memory_note',
  description:
    '今日の作業ノートに追記する。MEMORY.md に入れるほどではない詳細・経緯・試行錯誤を残す場所。' +
    '夢 (dream) はこのノートとセッションログを突き合わせて記憶を訂正する。',
  parameters: {
    text: { type: 'string', required: true, description: '追記する本文 (Markdown)' },
    date: { type: 'string', description: 'YYYY-MM-DD。省略時は今日。' },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { path: { type: 'string' }, ok: { type: 'boolean' } },
    },
    render: (_a, v) => [{ type: 'text', text: `note: ${v.path}` }],
  },
  async execute(args) {
    await ensureDirs()
    const date = args.date || today()
    const file = join(paths.notes(), `${date}.md`)
    const exists = existsSync(file)
    const body = exists ? `\n\n${args.text.trim()}\n` : `# ${date}\n\n${args.text.trim()}\n`
    await appendFile(file, body, 'utf8')
    return { ok: true, path: file }
  },
})

const wikiTool = defineTool({
  name: 'memory_wiki',
  description:
    'トピック別の記憶ページ (wiki) を読み書きする。MEMORY.md から詳細を降ろす先。' +
    '1 トピック 1 ファイル。既存ページは全文置換なので、読んでから書くこと。',
  parameters: {
    topic: {
      type: 'string',
      required: true,
      description: 'トピック名 (kebab-case)。例: "pc-parts-watch", "note-accounts"',
    },
    content: {
      type: 'string',
      description: '新しい全文。省略すると読み取りになる。',
    },
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
      },
    },
    render: (_a, v) => [
      {
        type: 'text',
        text: v.written
          ? `wiki: ${v.topic} を更新 (${v.content.length} 字)`
          : v.content
            ? `wiki: ${v.topic}\n\n${v.content}`
            : `wiki: 既存トピック — ${(v.topics || []).join(', ') || '(なし)'}`,
      },
    ],
  },
  async execute(args) {
    await ensureDirs()
    const topic = String(args.topic).trim()
    if (!/^[a-z0-9][a-z0-9-]*$/.test(topic)) {
      throw new Error('topic は kebab-case (英小文字・数字・ハイフン) で指定してください')
    }
    const file = join(paths.wiki(), `${topic}.md`)

    if (args.content === undefined) {
      const content = await readText(file, '')
      if (content) return { topic, path: file, content, written: false }
      const files = await readdir(paths.wiki()).catch(() => [])
      return {
        topic,
        path: file,
        content: '',
        written: false,
        topics: files.filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')),
      }
    }

    const content = String(args.content).trim()
    await writeText(file, `# ${topic}\n\n${content}\n`)
    return { topic, path: file, content, written: true }
  },
})

// ---------------------------------------------------------------- dream

const dreamTool = defineTool({
  name: 'memory_dream',
  description:
    '夢を見る。直近のノート・セッションログ・MEMORY.md を突き合わせ、' +
    '「間違っている記述」「古くなった記述」を訂正し、日付つきの夢を書く。' +
    '生成ではなく訂正が目的。新しい事実を足すのではなく、既にある記述を検証する。',
  parameters: {
    date: { type: 'string', description: 'YYYY-MM-DD。省略時は今日。' },
    synthesis: {
      type: 'string',
      description: '現在の行動指針 (SYNTHESIS.md) の新しい全文。省略時は更新しない。',
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        dream_path: { type: 'string' },
        material: { type: 'string' },
        memory_usage: { type: 'string' },
      },
    },
    render: (_a, v) => [{ type: 'text', text: v.material }],
  },
  async execute(args) {
    await ensureDirs()
    const date = args.date || today()
    // 夢の材料も注入経路なので、汚染されたエントリは差し替えて渡す
    const parsed = await loadMemoryForInjection()

    // 夢の材料: 直近のノート + 現在の記憶
    const noteFiles = (await readdir(paths.notes()).catch(() => []))
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .slice(-config.lookbackDays)

    const notes = []
    for (const f of noteFiles) {
      const body = await readText(join(paths.notes(), f))
      // ノートも外部由来の文章を含みうるので同じスキャンを通す
      const g = guardMemoryText(body, `notes/${f}`)
      notes.push(`### ${f.replace(/\.md$/, '')}\n${g.text}`)
    }

    const material = [
      `# 夢の材料 — ${date}`,
      '',
      `## 現在の MEMORY.md (${charCount(parsed.entries)}/${config.memoryCharLimit} 字, ${parsed.entries.length} 件)`,
      '',
      ...parsed.entries.map((e, i) => `${i + 1}. ${e}`),
      '',
      `## 直近 ${noteFiles.length} 日分のノート`,
      '',
      notes.join('\n\n') || '(ノートなし)',
    ].join('\n')

    if (args.synthesis !== undefined) {
      await writeText(
        paths.synthesis(),
        `# 現在の指針\n\n<!-- 夢が更新する。注入層から参照される。 -->\n\n${String(args.synthesis).trim()}\n`,
      )
    }

    const dreamPath = join(paths.dreams(), `${date}.md`)
    return {
      ok: true,
      dream_path: dreamPath,
      material,
      memory_usage: `${charCount(parsed.entries)}/${config.memoryCharLimit}`,
    }
  },
})

// ---------------------------------------------------------------- status

const statusTool = defineTool({
  name: 'memory_status',
  description: '記憶階層の現在の状態を表示する。何がどこにどれだけあるか。',
  parameters: {},
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        memory_usage: { type: 'string' },
        memory_count: { type: 'number' },
        notes: { type: 'number' },
        wiki: { type: 'array', items: { type: 'string' } },
        dreams: { type: 'number' },
        synthesis_chars: { type: 'number' },
        root: { type: 'string' },
      },
    },
    render: (_a, v) => [
      {
        type: 'text',
        text: [
          `記憶階層 — ${v.root}`,
          `  MEMORY.md   ${v.memory_usage} 字 / ${v.memory_count} エントリ`,
          `  notes/      ${v.notes} ファイル`,
          `  wiki/       ${v.wiki.length} ページ${v.wiki.length ? ` (${v.wiki.join(', ')})` : ''}`,
          `  dreams/     ${v.dreams} ファイル`,
          `  SYNTHESIS   ${v.synthesis_chars} 字`,
        ].join('\n'),
      },
    ],
  },
  async execute() {
    await ensureDirs()
    const parsed = await loadMemory()
    const notes = (await readdir(paths.notes()).catch(() => [])).filter((f) => f.endsWith('.md'))
    const wiki = (await readdir(paths.wiki()).catch(() => []))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
    const dreams = (await readdir(paths.dreams()).catch(() => [])).filter((f) =>
      /^\d{4}-\d{2}-\d{2}\.md$/.test(f),
    )
    const synthesis = await readText(paths.synthesis(), '')

    return {
      root: paths.root(),
      memory_usage: `${charCount(parsed.entries)}/${config.memoryCharLimit}`,
      memory_count: parsed.entries.length,
      notes: notes.length,
      wiki,
      dreams: dreams.length,
      synthesis_chars: synthesis.length,
    }
  },
})

function today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// ---------------------------------------------------------------- audit

const auditTool = defineTool({
  name: 'memory_audit',
  description:
    '記憶に注入パターン（指示の上書き、役割の再定義、秘密の持ち出し等）が混ざっていないか検査する。' +
    '夢が外部ページの文章を拾って MEMORY.md に入れると、それが翌日以降の恒久的な命令になってしまうため、' +
    '注入前にエントリ単位でスキャンしている。ここでは全階層をまとめて検査して一覧を返す。',
  parameters: {
    fix: {
      type: 'boolean',
      description: 'true なら検出した MEMORY.md のエントリを削除する。既定は検査のみ。',
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        scanned: { type: 'number' },
        findings: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              layer: { type: 'string' },
              file: { type: 'string' },
              hits: { type: 'array', items: { type: 'string' } },
              preview: { type: 'string' },
            },
          },
        },
        removed: { type: 'number' },
      },
    },
    render: (_a, v) => {
      if (v.findings.length === 0) {
        return [{ type: 'text', text: `memory_audit: ${v.scanned} 件を検査、問題なし` }]
      }
      const lines = [`memory_audit: ${v.scanned} 件中 ${v.findings.length} 件に検出`]
      for (const f of v.findings) {
        lines.push(`  [${f.layer}] ${f.file} — ${f.hits.join(', ')}`)
        lines.push(`    ${f.preview}`)
      }
      if (v.removed > 0) lines.push(`MEMORY.md から ${v.removed} 件を削除しました`)
      else lines.push('（検査のみ。fix: true で MEMORY.md の該当エントリを削除します）')
      return [{ type: 'text', text: lines.join('\n') }]
    },
  },
  async execute(args) {
    await ensureDirs()
    const findings = []
    let scanned = 0

    // 1. MEMORY.md（エントリ単位）
    const parsed = await loadMemory()
    const keep = []
    let removed = 0
    for (const entry of parsed.entries) {
      scanned++
      const hits = scanForInjection(entry)
      if (hits.length === 0) {
        keep.push(entry)
        continue
      }
      findings.push({
        layer: 'MEMORY.md',
        file: paths.memory(),
        hits,
        preview: preview(entry, 80),
      })
      if (args.fix === true) removed++
      else keep.push(entry)
    }
    if (args.fix === true && removed > 0) {
      await saveMemory({ header: parsed.header, entries: keep })
    }

    // 2. wiki
    for (const f of (await readdir(paths.wiki()).catch(() => [])).filter((x) => x.endsWith('.md'))) {
      scanned++
      const body = await readText(join(paths.wiki(), f), '')
      const hits = scanForInjection(body)
      if (hits.length) {
        findings.push({ layer: 'wiki', file: f, hits, preview: preview(body, 80) })
      }
    }

    // 3. notes
    for (const f of (await readdir(paths.notes()).catch(() => [])).filter((x) => x.endsWith('.md'))) {
      scanned++
      const body = await readText(join(paths.notes(), f), '')
      const hits = scanForInjection(body)
      if (hits.length) {
        findings.push({ layer: 'notes', file: f, hits, preview: preview(body, 80) })
      }
    }

    // 4. dreams + synthesis
    for (const f of (await readdir(paths.dreams()).catch(() => [])).filter((x) => x.endsWith('.md'))) {
      scanned++
      const body = await readText(join(paths.dreams(), f), '')
      const hits = scanForInjection(body)
      if (hits.length) {
        findings.push({ layer: 'dreams', file: f, hits, preview: preview(body, 80) })
      }
    }

    return { ok: findings.length === 0, scanned, findings, removed }
  },
})

// ---------------------------------------------------------------- apply

export function apply(ctx, cfg = {}) {
  config = { ...DEFAULTS, ...cfg }

  ctx.tools.register(memoryTool)
  ctx.tools.register(noteTool)
  ctx.tools.register(wikiTool)
  ctx.tools.register(dreamTool)
  ctx.tools.register(statusTool)
  ctx.tools.register(auditTool)

  // 初回起動時にディレクトリと空の MEMORY.md を用意する
  void ensureDirs().then(async () => {
    if (!existsSync(paths.memory())) {
      await writeText(
        paths.memory(),
        renderMemory({
          header: '',
          entries: [],
        }),
      )
    }
  })
}
