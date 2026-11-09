# dsh-memory

**Persistent, human-editable memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**

[![CI](https://github.com/AaronWang-cpu/dsh-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/AaronWang-cpu/dsh-memory/actions/workflows/ci.yml)

English | [中文](README.zh.md)

The agent forgets everything when a session ends. `dsh-memory` gives it one small place to
remember — a plain JSONL file you can read, edit, delete, and back up.

Tell it once:

```
You   › I always use pnpm, never npm. And answer me in Chinese.
Agent › Saved. (memory 4f2a91c8)
```

Open a brand-new session tomorrow:

```
You   › 这个项目装依赖该用什么？
Agent › pnpm。
```

No tool call, no re-explanation, no "as you mentioned earlier" — the fact is simply in the
prompt from the first token.

---

## Why this instead of `AGENTS.md`?

`AGENTS.md` is project guidance: static, shared, committed to the repository, written by
whoever maintains it. Memory is personal: written by the agent as it learns you, kept outside
the repo, and applied to every project.

| | `AGENTS.md` | `dsh-memory` |
|---|---|---|
| Written by | a human, by hand | the agent, during work |
| Scope | one repository | you, everywhere |
| Lives in | the repo (committed) | `~/.dsh/memory/` (private) |
| Grows | when someone edits it | automatically, deduplicated |
| Budget | whatever fits | capped in bytes, newest first |

They compose. Keep coding conventions in `AGENTS.md`, keep *you* in memory.

## Install

```bash
dsh plugin --profile desktop add github:AaronWang-cpu/dsh-memory
```

Then restart DSH. That is the whole setup: there is nothing to configure, no API key, no
network access, no background service.

<details>
<summary>Install from a local checkout</summary>

```bash
dsh plugin --profile desktop add /absolute/path/to/dsh-memory
```

Or add it by hand to `~/.dsh/profiles/desktop/package.json`:

```json
{
  "dependencies": { "dsh-memory": "github:AaronWang-cpu/dsh-memory" },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-memory"
      ]
    }
  }
}
```

</details>

## Use

Nothing to learn: memory is used by talking.

| You say | What happens |
|---|---|
| "I always use pnpm." | Saved as a durable preference |
| "以后的提交信息都用中文" | Saved |
| "Our staging DB is read-only, never write to it." | Saved — a constraint worth not re-learning |
| "What do I usually prefer?" | The agent searches memory |
| "Forget what I said about pnpm." | List, find, forget |

The agent decides when something is worth remembering; the tool's description tells it to
skip transient task state and anything already readable from a file.

## How it works

Two mechanisms, one store:

1. **The `memory` tool** — one tool with four actions (`save`, `search`, `list`, `forget`).
   `save` folds whitespace and de-duplicates case-insensitively, so restating a fact updates
   it instead of piling up near-copies.
2. **A prompt section** — registered through `ctx.systemPrompt.section()` at order `10150`,
   after the Web surface and before the persona suffix. Its text is a *function*, so it is
   re-rendered at every assembly: a fact saved in one session is visible in the next step of
   every other one, with no restart.

The section is byte-bounded (`maxBytes`, default 4096). Newest entries win; the section says
how many older ones were left out, and a tight budget degrades to a shorter header rather
than silently dropping the feature.

## Storage

```
~/.dsh/memory/memory.jsonl
```

One JSON object per line:

```json
{"id":"4f2a91c8","content":"Prefers pnpm over npm.","tags":["preference","tooling"],"createdAt":"2026-11-09T08:12:44.101Z","updatedAt":"2026-11-09T08:12:44.101Z"}
```

- **Yours.** It is a text file: `cat`, `grep`, `git`, edit it by hand, delete a line.
- **Safe to edit.** A malformed line is skipped, not fatal — one typo does not disable the plugin.
- **Atomic.** Writes go to a temp file and are renamed, so a crash mid-write cannot truncate it.
- **Local.** Nothing is uploaded. There is no account, no telemetry, no network code at all.

## Configuration

Optional; the defaults are what most people want. In your profile's `cordis.patch.yml`:

```yaml
- id: dsh-memory
  name: 'dsh-memory'
  config:
    dir: 'C:/Users/me/.dsh/memory'   # default: <DSH home>/memory
    maxBytes: 4096                   # prompt-section budget
    maxEntries: 500                  # oldest evicted beyond this
```

| Field | Default | Meaning |
|---|---|---|
| `dir` | `<DSH home>/memory` | Store directory. `DSH_HOME` is honoured when set. |
| `maxBytes` | `4096` | Byte budget for the injected section. |
| `maxEntries` | `500` | Hard cap on stored entries; the oldest is evicted first. |

## Limits

Honest list of what this version does **not** do:

- **One global store.** Memories apply to every workspace. Per-project scope is not implemented.
- **Substring search.** No embeddings, no ranking — `search` is a case-insensitive substring
  match on content and tags. That is enough for a few hundred short facts and costs nothing.
- **No automatic extraction.** The agent saves explicitly; there is no post-turn summariser
  burning tokens behind your back.
- **No UI.** No settings page, no panel — a tool and a prompt section only.
- **Prompt tokens.** The section costs what it costs: 4 KB is roughly 1 K tokens on every
  request. Lower `maxBytes` if that matters to you.

## Requirements

- DeepSeek Harness `0.2.x` — the Host API this plugin targets is the one shipped in `0.2.2-rc.1`
  (`ctx.tools.register`, `ctx.systemPrompt.section`)
- Node `>= 20`
- No dependencies. The plugin imports only Node's standard library.

## Development

```bash
node test/smoke.mjs
```

Mounts the plugin against a stub context the way the loader would, then drives the tool and
the prompt section against a temporary store: 35 checks covering de-duplication, budget
trimming, eviction, malformed-line resilience, and argument validation. No test framework,
no install step.

## Licence

MIT — see [LICENSE](LICENSE).
