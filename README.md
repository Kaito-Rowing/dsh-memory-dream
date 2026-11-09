# dsh-memory-dream

English | [日本語](README.ja.md)

Layered agent memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), with a dream pass that **checks memory against the actual conversation** and records what it cannot resolve.

Most memory plugins help an agent remember more. This one starts from a different question: what should be allowed to persist, and how does the agent find out it was wrong?

The design follows Anthropic's account of agent memory as a hierarchy — *[The components of agent memory](https://www.anthropic.com/research/components-of-agent-memory)* (2026) — and the hard-cap mechanism from Hermes Agent's `MEMORY.md`.

![Architecture](docs/architecture.svg)

## What it actually does

Four layers, smallest and most expensive first:

| Layer | Location | Role |
|---|---|---|
| injected | `~/.dsh/memory/MEMORY.md` | index of what is currently true, hard cap, read every turn |
| wiki | `~/.dsh/memory/wiki/<topic>.md` | detail, one topic per page |
| notes | `~/.dsh/memory/notes/YYYY-MM-DD.md` | what the agent recorded at the time |
| transcripts | `~/.dsh/sessions/` | what was actually said |

Two artifacts the dream writes:

| Artifact | Location | Role |
|---|---|---|
| dream record | `~/.dsh/memory/dreams/YYYY-MM-DD.md` | history — appended to, never rewritten |
| synthesis | `~/.dsh/memory/dreams/SYNTHESIS.md` | current guidance — rewritten freely |

## The three ideas

### 1. The cap forces consolidation

`MEMORY.md` has a character limit (default 4,000). A write that would exceed it is rejected, and every current entry comes back with the error:

```json
{
  "success": false,
  "error": "MEMORY.md would exceed its limit (4231/4000 chars, 231 over). Retry as ONE operations batch ...",
  "current_entries": ["...", "..."],
  "usage": "4000/4000"
}
```

The limit is checked only against the **final result of a batch**, so the agent can remove or shorten stale entries and add the new one in a single call. It cannot dribble entries in and hope.

This is a forcing function, not a storage limit. An agent that never hits the cap is an agent that never merges anything.

### 2. The dream reads the conversation, not just the notes

`memory_dream` assembles material from four sources: the current `MEMORY.md`, the **actual session transcripts**, the dated notes, and prior dreams. The transcript section is the one that matters — without it the dream can only compare two summaries of the same conversation, which catches drift but not error.

Transcripts are read from `~/.dsh/sessions/` as multi-frame zstd JSONL. Only user and assistant text is kept; tool calls, results and injected context are dropped, because the dream is checking what was *said*, and tool output is exactly the untrusted material that should not be re-presented as evidence.

The dream prompt is explicit about the limit of its authority:

> - **Contradicted by the evidence** — patch it, and record what changed and why.
> - **Unresolvable** — memory and evidence disagree and nothing decides between them. Do NOT pick a winner. Record the conflict in the dream and leave the entry as it is.
>
> A correction you cannot ground is a fabrication with better manners.

Anthropic's Pokémon experiment is the clearest case for why this matters: an agent wrote that a landmark was on the east side of a mountain when it was on the west. Uncorrected, it walked off a ledge three times and gave up. Corrected against the transcript, it went straight back in. Generation would not have caught that. Only checking would.

### 3. Memory is injected, not remembered-to-read

`MEMORY.md` reaches the model through `ctx.systemPrompt.context`, so it is present on every turn without the agent having to decide to look. The wiki topic list rides along so the agent knows what detail exists and can read it on demand.

Whether injection is possible depends on the composition. A tree without `dsh-system-prompt` — the `headless` profile, for one — has no prompt to contribute to. The plugin still loads and every tool works; `memory_status` reports the state:

```
injection   off — this composition has no systemPrompt service; memory is reachable only through the tools
```

This is deliberate. Declaring `systemPrompt` in `inject` would make it mandatory and the plugin would fail to activate in those compositions.

## Injection scanning

Memory is read back into the prompt, which makes it an injection surface: whatever the agent picks up from a web page and writes into `MEMORY.md` becomes an instruction to its future self.

Every read path — the injected context, `memory_wiki` reads, dream material, transcripts — is scanned **entry by entry**. A blocking hit is replaced by a marker that names the pattern and says where the original still lives:

```
[BLOCKED: MEMORY.md entry 2 matched injection pattern(s) override, exfil-prompt.
The original text is still on disk and was not loaded.
Run memory_audit to see it, then rewrite or delete the entry.]
```

Three decisions shape this:

- **Per entry, not per file.** One poisoned entry should not cost the whole store.
- **Replace, not delete.** The original text stays on disk. A false positive costs a visible marker, not a lost fact.
- **Two severities.** `block` hides the text; `flag` only reports it, because the shape is ambiguous enough that hiding it would cost more than it saves.

`memory_audit` scans every layer and shows the original text. `fix: true` removes flagged `MEMORY.md` entries; it never touches wiki pages or notes, which are the user's own record.

**This is a tripwire, not a guarantee.** Regex heuristics miss paraphrased attacks and will occasionally flag legitimate text — a note *about* injection techniques, for instance. The goal is noticing, not blocking.

## Install

```bash
dsh plugin --profile web add github:Kaito-Rowing/dsh-memory-dream
```

Or from a local checkout:

```bash
dsh plugin --profile web add link:/path/to/dsh-memory-dream
```

Restart the profile. The plugin creates `~/.dsh/memory/` on first use.

## Tools

| Tool | What it does |
|---|---|
| `memory` | `add` / `patch` / `remove` against `MEMORY.md`. Enforces the cap. |
| `memory_note` | Append to a dated note. |
| `memory_wiki` | Read or write a topic page. Omit `content` to read. |
| `memory_dream` | Assemble dream material; optionally write the record and synthesis. |
| `memory_status` | Usage, counts, whether injection is active, and lock state. |
| `memory_audit` | Scan every layer for injection patterns. |

## Config

```yaml
- id: memory-dream
  name: dsh-memory-dream
  config:
    memoryCharLimit: 4000        # cap on MEMORY.md
    lookbackDays: 14             # window for notes and transcripts
    memoryDir: null              # default: $DSH_HOME/memory
    scanInjection: true          # scan memory before it reaches the model
    inject: true                 # inject MEMORY.md every turn
    injectTopics: true           # include the wiki topic list
    transcripts: true            # read session transcripts for the dream
    transcriptMaxChars: 40000    # text budget for transcripts
    transcriptsSameWorkspace: true  # only sessions from the current workspace
    language: en                 # tool text: en | ja
    log: false                   # local development telemetry (see below)
```

Every default works on a fresh install. Invalid values fall back to the default rather than failing.

## Scheduling the dream

DSH's `schedule` service can deliver a prompt to a fresh session on a timer. Create a task with an RRULE and a prompt like:

```
Run memory_dream. Read the material and verify what is already written
against the transcripts rather than adding new facts. Patch entries the
evidence contradicts, move detail into memory_wiki, and remove what is
stale. Where the evidence cannot settle a disagreement, record the conflict
and leave the entry alone. Then write today's dream with the record
parameter: what you corrected, what is unresolved, and tomorrow's first
move. Run memory_audit and investigate anything it blocks.
```

Nightly is a reasonable default. Anthropic notes that the right cadence is still an open question — if the dream keeps finding nothing, run it less often.

## Local development telemetry

Debugging a memory system means answering questions the tool results do not:
did the dream actually read the transcripts, or did it fall back? Did the cap
reject the batch, or did the write fail? Was that a real correction or a
model hallucination?

Setting `log: true` records structured events to a local directory. **It is off
by default**, writes outside the repository, and nothing it records is ever fed
back into the model.

```yaml
- id: memory-dream
  name: dsh-memory-dream
  config:
    log: true
    logDir: /home/you/.dsh-memory-dream-logs   # optional; this is the default location
    logDebug: false                            # extra fields, still no text
    logMaxBytes: 8388608                       # rotate after 8 MiB
    logMaxFiles: 5                             # keep 5 rotated files
```

Two outputs, because they answer different questions:

| File | For |
|---|---|
| `events.jsonl` | one JSON object per line, for `jq` and scripts |
| `runs/<runId>.md` | a one-page human summary of a dream |

Every event carries `runId`, so a dream can be reconstructed by filtering on
it. A run reads like this:

```
09:17:18.097 plugin.start             cap=4000 lookback=14d inject=true
09:17:18.109 memory.write        11ms applied=1 entries=1 usage=24/4000
09:17:18.113 note.append          2ms date=2026-11-09 chars=6
09:17:18.120 audit                    FAIL scanned=4 findings=1 removed=0
09:17:18.121 dream.start              date=2026-11-09 record=true
09:17:18.123 dream.material           memory=2/61c notes=1 sessions=17 transcript=4821c ws=ok blocked=1
09:17:18.125 dream.record             chars=22 appended=false
09:17:18.125 dream.end            4ms record=true synthesis=false
```

`scripts/log-report.mjs` reads the log:

```bash
node scripts/log-report.mjs ~/.dsh-memory-dream-logs            # timeline
node scripts/log-report.mjs ~/.dsh-memory-dream-logs --runs     # run index
node scripts/log-report.mjs ~/.dsh-memory-dream-logs --slow     # slowest operations
node scripts/log-report.mjs ~/.dsh-memory-dream-logs --run run_x --json
```

### What is recorded

Counts, durations, ids, outcomes and pattern names. Specifically:

- `memory.write` — how many operations of each kind were requested, how many
  applied, the resulting entry count and usage, and whether the cap rejected it
- `dream.material` — entries, notes, sessions, transcript characters, whether
  the workspace filter matched or fell back, blocked-entry count
- `dream.record` / `dream.synthesis` — characters and lines written, whether it
  was an append
- `audit` — per-layer finding counts, severities, and which patterns fired
- `inject.render` — size and entry count of the injected context
- `lock.degraded` — a write that proceeded without the cross-process lock
- `wiki.read` / `wiki.write` / `note.append` — topic, size, blocked flag

### What is never recorded

Memory text, wiki text, note text, dream records, conversation transcripts,
prompts, API keys and credentials. The logger sanitizes every field: strings
are truncated to 200 characters, arrays capped, depth bounded, and a fixed list
of content-bearing keys (`text`, `content`, `prompt`, `message`, `memory`,
`token`, `apiKey`, …) is replaced with `[redacted]` even if a caller passes it.

`logDebug` adds a marker and extra timing fields. It does not enable content
capture — there is no mode that records text.

### Safety properties

- **A logging failure cannot break memory.** Every write is wrapped; a broken
  path disables the logger after the first error and the memory operations
  continue. There is a test that points `logDir` at a file and asserts the
  write still succeeds.
- **Files are owner-only** (`0o600`) on POSIX.
- **Rotation** keeps `events.jsonl` under `logMaxBytes` and prunes rotated
  files beyond `logMaxFiles`.
- **A log directory inside a git worktree is refused**, and `memory_status`
  says so. The `.gitignore` also covers the default location, so a mistake in
  either place does not end up in a commit.
- **Logs are never injected.** They are not part of the memory hierarchy and
  no code path reads them back into a prompt.

### Relation to `dreams/`

`dreams/YYYY-MM-DD.md` is a *memory artifact*: what the agent concluded about
itself, kept as history and readable by the agent later. The telemetry log is a
*development artifact*: what the plugin mechanically did, for a human
debugging it. They are written to different places, by different code, and
neither is derived from the other.

## Data safety

- **Atomic replacement.** `MEMORY.md`, wiki pages, dream records and the synthesis are written to a temp file in the same directory and renamed into place, so a crash mid-write cannot truncate an existing file.
- **Serialized appends.** Notes are appended rather than replaced, so they are not atomic in that sense — but the append holds the same lock, because two appends racing on one file can interleave their bytes.
- **One writer per root.** An in-process mutex serializes writes exactly. A lock file coordinates across processes; a lock older than 30 seconds is broken rather than blocking forever.
- **Lock failure is reported, not silent.** If the lock file cannot be acquired within 5 seconds, the write still proceeds — the in-process mutex already covers the common case, and refusing to save a memory because a stale lock exists would lose data to protect against a race that may not exist. The degradation is recorded and shown by `memory_status`:

  ```
  lock        ok — every write held the cross-process lock
  lock        degraded 1x — last: another process holds the lock
  ```

- **Path validation.** Every model-supplied name is validated before it becomes a path: dates must be real calendar dates (`2026-02-30` and `../../etc/passwd` both fail), topics must be kebab-case, and the resolved path is confirmed to stay under the memory root.
- **Compatible with 0.1 data.** The 0.1 release wrote the entry separator as `§ ` prefixed to the following line. The parser recognizes both that shape and the current one, so an existing store keeps working.

## Design notes

**Why a cap and not a token budget?** Characters are cheap to count, deterministic, and visible to the model in the usage line. A token budget would need the tokenizer at write time.

**Why does `memory_dream` return material instead of writing the dream itself?** Because the writing is the model's job, and the plugin should not pretend to do reasoning. The tool assembles inputs and provides a place to write; the prompt supplies the judgment.

**Why separate `dreams/` from `SYNTHESIS.md`?** The dated dream is history — it should never be rewritten. The synthesis is current guidance — it should be rewritten whenever the picture changes. Collapsing them means either losing the trail or carrying stale instructions forever.

**Why is a second dream on the same day appended, not overwritten?** Because a re-run is usually a correction of the first pass, and the first pass's conclusions are evidence about what was believed at the time.

## Known limits

- **Injection needs `dsh-system-prompt`.** Compositions without it (headless) get the tools but no automatic context. `memory_status` says so.
- **Transcript reading is filesystem-level.** It reads the JSONL generations directly rather than going through `ctx.sessionQuery`, so a future format change would need a matching update. The reader is conservative — it skips unreadable frames and never writes.
- **The scanner is heuristic.** See above.
- **`transcriptsSameWorkspace` matches the encoded directory name.** If the encoding scheme changes, the filter matches nothing — so the reader falls back to every workspace and says so in the dream material, rather than returning an empty result that looks like "there was nothing to read".
- **The cross-process lock is advisory.** It is a lock file, not an OS advisory lock. It coordinates two processes that both use this plugin; it cannot stop an unrelated program from writing to the same files.

## License

MIT
