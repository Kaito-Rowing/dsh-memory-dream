# DSH community announcement draft — post only after release

**Discussion category:** [Show Your Plugins!](https://github.com/deepseek-ai/deepseek-harness/discussions/categories/show-your-plugins)

**Suggested title:** dsh-memory-dream v0.3.0 — bounded agent memory, checked against real conversations

---

I built **dsh-memory-dream**, a community memory plugin for DeepSeek Harness.

Many memory tools focus on storing *more*. This one asks a different question: **how does an agent find out when its own memory is wrong?**

It combines:

- A compact `MEMORY.md` index, injected when the system-prompt service is available (default 4,000-character cap).
- Dated notes and per-topic wiki files for details.
- `memory_dream`, which gathers recent conversations, notes and existing memory so the agent can **verify claims against the actual dialogue**.
- A simple rule for uncertainty: if the conversation doesn't settle a contradiction, record it—don't invent a correction.
- A local injection scanner, audit/status tools and optional diagnostic telemetry.

**Install from npm** (after the package is published):

```bash
dsh plugin --profile web add dsh-memory-dream
```

**Or install from GitHub**:

```bash
dsh plugin --profile web add github:Kaito-Rowing/dsh-memory-dream#v0.3.0
```

After restarting the profile, ask the agent to run `memory_status`. Dream review is requested explicitly or scheduled through DSH; it is not an autonomous background LLM task. Node 22.15+ is needed for compressed transcript reading.

**Source / architecture / docs:** https://github.com/Kaito-Rowing/dsh-memory-dream

It's MIT licensed and independent from the DeepSeek team. I'd love feedback from people using DSH with long-running sessions, especially on how well evidence-based memory correction works in real projects.

**Privacy note:** Memory and transcripts can contain sensitive information. Workspace-scoped transcript reading stays within the selected workspace by default; review the security docs before enabling broader access.

---

## Japanese short post

DeepSeek Harness向けの記憶プラグイン **dsh-memory-dream** を作りました。記憶を無制限に増やすのではなく、文字数上限のある `MEMORY.md` と日付つきノート・wikiを使い分けます。`memory_dream` は会話ログを根拠として集め、**記憶が間違っていないかをモデルが検証**できるようにします。根拠が足りなければ勝手に訂正せず、矛盾として残す設計です。

GitHub: https://github.com/Kaito-Rowing/dsh-memory-dream

MITライセンス、英日READMEあり。フィードバック歓迎です。
