![Memory Dream — Make memory accountable](docs/hero.svg)

# dsh-memory-dream

**Memory that checks its own story.** A community-built memory plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Keep a small, persistent index; store the details separately; use real conversation transcripts to question what the agent thinks it remembers.

[![Tests](https://github.com/Kaito-Rowing/dsh-memory-dream/actions/workflows/test.yml/badge.svg)](https://github.com/Kaito-Rowing/dsh-memory-dream/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-5865d8.svg)](LICENSE)
![Node.js: 20+](https://img.shields.io/badge/node.js-20%2B-26735c.svg)
![Version: 0.3.0](https://img.shields.io/badge/source-v0.3.0-59627a.svg)

**English** · [日本語](README.ja.md) · [Technical guide](docs/guide.md) · [Changelog](CHANGELOG.md)

---

## Why it exists

Agents are good at writing things down. They are less reliable at noticing when a remembered fact became outdated—or was wrong to begin with.

**dsh-memory-dream separates memory from evidence.** Your agent can keep useful context close without treating every previous note as unquestionable truth.

| Keep it small | Keep the detail | Check the evidence |
|:---|:---|:---|
| A character-capped `MEMORY.md` index is injected when the system-prompt service is available. | Topic wikis and dated notes hold context outside the index. | On request, `memory_dream` gathers transcripts and notes so the **agent** can verify, correct, or leave a conflict open. |

## Quick start

Install into an existing DSH profile (here, `web`):

```bash
dsh plugin --profile web add github:Kaito-Rowing/dsh-memory-dream
```

Restart the profile, then ask the **DSH agent**, not your terminal:

> Run `memory_status`. Is memory injection active in this profile?

Try saving a harmless preference using `memory`, then ask the agent to read it back. The default store lives in `~/.dsh/memory/` (or `$DSH_HOME/memory/`).

**Requirements:** DeepSeek Harness and Node.js 20+. **Node 22.15+** is required to read zstd-compressed session transcripts; on Node 20 the plugin loads, but transcript-backed dream review is unavailable. Prompt injection requires a DSH composition with the `systemPrompt` service; the tools work without it.

## How the pieces fit

![The two actual paths: per-turn injection and on-demand evidence review](docs/architecture.svg)

**Two separate operations—not one automatic background job:**

1. **Every turn, when supported:** `MEMORY.md` and the wiki topic list are exposed to the agent through the system prompt context. The index has a default hard cap of **4,000 characters**.
2. **When asked:** `memory_dream` assembles the current index, available conversation transcripts, notes, and previous dream records. The **model** judges the evidence; it may use memory tools to make a correction and write a dream record. Unresolved contradictions should stay unresolved.

### Where things live

| Location | Purpose |
|---|---|
| `memory/MEMORY.md` | Small index: current useful claims, hard capped |
| `memory/wiki/<topic>.md` | Detailed topic pages, read on demand |
| `memory/notes/YYYY-MM-DD.md` | Dated working notes |
| `sessions/` | Conversation evidence maintained by DSH |
| `memory/dreams/YYYY-MM-DD.md` | Append-only history of review decisions |
| `memory/dreams/SYNTHESIS.md` | Rewritable current guidance |

The paths above are relative to `~/.dsh/` by default. `MEMORY.md` is not an unlimited chat archive: the cap forces the agent to revise or consolidate entries.

## Tools

| Tool | Use it for |
|---|---|
| `memory` | Add, patch, or remove index entries in **one atomic operations batch** |
| `memory_note` | Append a dated working note |
| `memory_wiki` | Read or replace a topic page |
| `memory_dream` | Gather evidence; optionally write a dated dream record and synthesis |
| `memory_status` | Inspect usage, injection status, and lock health |
| `memory_audit` | Inspect heuristic prompt-injection findings |

**Example dream prompt** (send this to your agent):

> Use `memory_dream` to compare our current memory with recent conversations. Fix only claims contradicted by the evidence. Record anything you cannot resolve rather than guessing. Write a dated dream record of what changed and why.

`memory_dream` does **not** run a model itself. If you want scheduled reviews, create a DSH schedule that sends the prompt to an agent session.

## Configuration

Everything works with defaults. To customize, add a config block for the plugin in your DSH composition:

```yaml
- id: memory-dream
  name: dsh-memory-dream
  config:
    memoryCharLimit: 4000
    lookbackDays: 14
    inject: true
    transcripts: true
    transcriptsSameWorkspace: true
    scanInjection: true
    log: false
```

See the [full configuration reference and design notes](docs/guide.md#config) for all settings, optional local telemetry, dream scheduling, and migration tools.

## Important boundaries

- **Workspace isolation:** When `transcriptsSameWorkspace: true` (the default), transcript reading **does not widen to other workspaces** if no sessions match. Dream review then reports that evidence is missing. Set `transcriptsSameWorkspace: false` only when intentionally reviewing all workspaces.
- **Privacy:** Memory and transcripts can contain sensitive information. Files live locally, but content passed to an agent is processed by your configured model provider. Don't publish raw debug snapshots.
- **Safety:** The prompt-injection scanner is heuristic, not a security guarantee. Cross-process locking is best-effort. Back up memory before using `memory_audit` with `fix: true`.

Read [Security](SECURITY.md), [Known limitations](docs/guide.md#known-limits), and [Contributing](CONTRIBUTING.md) before deployment or contributions.

---

<sub>MIT licensed · Independent community project; not affiliated with or endorsed by DeepSeek. · [日本語版](README.ja.md)</sub>
