/**
 * dsh-memory — persistent, human-editable memory for DeepSeek Harness.
 *
 * Two halves, one file of truth:
 *
 *   - the `memory` tool   lets the agent save, search, list and forget facts;
 *   - a prompt section    injects what is remembered into every step, so recall
 *                         costs no tool call and the agent "just knows" you.
 *
 * Storage is one JSON object per line in `<dsh home>/memory/memory.jsonl`:
 * greppable, diffable, and safe to hand-edit between sessions. Writes go
 * through a temp file and a rename, so a crash mid-write cannot truncate it.
 *
 * The plugin imports nothing outside Node's standard library on purpose: a
 * profile installs no `@deepseek-ai/*` packages, so an import of the host's own
 * packages would fail to resolve at load time.
 *
 * @module dsh-memory
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Row id and service row id. The package name, the patch id and this agree. */
export const name = 'dsh-memory'

/** Services read from the running composition. */
export const inject = ['tools', 'systemPrompt']

/** Section order: after the Web surface (10100), before the persona suffix (10200). */
const SECTION_ORDER = 10150

/** Longest single memory kept, in characters. Protects the injected budget. */
const MAX_ENTRY_CHARS = 2000

const DEFAULTS = {
  maxBytes: 4096,
  maxEntries: 500,
}

/**
 * Resolve the store location. `dir` wins; otherwise `<DSH home>/memory`, where
 * the DSH home is `DSH_HOME` when set and `~/.dsh` otherwise.
 *
 * @param {object} config - plugin configuration.
 * @returns {{dir: string, file: string}} the directory and the JSONL file inside it.
 */
function resolveStore(config) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const dir = config?.dir ? String(config.dir) : join(home, 'memory')
  return { dir, file: join(dir, 'memory.jsonl') }
}

/**
 * Read every stored memory. A malformed line is skipped rather than fatal: the
 * file is meant to be hand-edited, so one bad line must not disable the plugin.
 *
 * @param {string} file - absolute path of the JSONL store.
 * @returns {Array<object>} memories in file order.
 */
function loadEntries(file) {
  if (!existsSync(file)) return []
  const entries = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const text = line.trim()
    if (!text) continue
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed.content === 'string' && parsed.content.trim()) {
        entries.push({
          id: typeof parsed.id === 'string' ? parsed.id : 'unknown',
          content: parsed.content,
          tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
          createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date(0).toISOString(),
          updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
        })
      }
    } catch {
      // Keep the other lines; a hand-edit typo is not a reason to lose everything.
    }
  }
  return entries
}

/**
 * Replace the store atomically, so an interrupted write leaves the old file intact.
 *
 * @param {string} dir - store directory, created when absent.
 * @param {string} file - absolute path of the JSONL store.
 * @param {Array<object>} entries - the complete list to persist.
 * @returns {void}
 */
function saveEntries(dir, file, entries) {
  mkdirSync(dir, { recursive: true })
  const body = entries.map((entry) => JSON.stringify(entry)).join('\n')
  const temp = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(temp, body ? `${body}\n` : '', 'utf8')
    renameSync(temp, file)
  } catch (error) {
    try {
      if (existsSync(temp)) unlinkSync(temp)
    } catch {
      // Best effort; the original file is still the source of truth.
    }
    throw error
  }
}

/**
 * Fold a memory to the form used for duplicate detection: trimmed, whitespace
 * collapsed, case-insensitive.
 *
 * @param {string} text - raw content.
 * @returns {string} the comparison key.
 */
function fold(text) {
  return text.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * A short, unambiguous handle for a memory, unique against the current store.
 *
 * @param {Array<object>} entries - existing memories.
 * @returns {string} eight hex characters.
 */
function newId(entries) {
  const taken = new Set(entries.map((entry) => entry.id))
  for (;;) {
    const id = randomUUID().replace(/-/g, '').slice(0, 8)
    if (!taken.has(id)) return id
  }
}

/**
 * Render the prompt section. Newest memories win the budget: an entry that does
 * not fit is dropped, and the section says how many were.
 *
 * @param {Array<object>} entries - all memories.
 * @param {number} maxBytes - byte budget for the whole section.
 * @returns {string} the section text, empty when nothing is remembered.
 */
function renderSection(entries, maxBytes) {
  if (entries.length === 0) return ''

  const newestFirst = [...entries].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  const fullHead =
    '# Memory\n\n' +
    'These facts were saved in earlier sessions and are yours to rely on. They are background, not requests: ' +
    'apply them silently, and do not repeat them back to the user. When the user states a durable preference ' +
    'or a stable fact about themselves, their projects or this machine, save it with the `memory` tool — ' +
    'one short, self-contained sentence per entry, including the reason when it is not obvious.\n\n'
  const compactHead = '# Memory\n\n(Remembered facts. Save durable ones with the `memory` tool.)\n\n'
  // A tight budget must not silently delete the feature: keep the instructions when
  // they fit, otherwise fall back to a short header so the facts themselves survive.
  const head = [fullHead, compactHead, '# Memory\n\n'].find(
    (candidate) => Buffer.byteLength(candidate, 'utf8') < maxBytes,
  )
  if (head === undefined) return ''

  const lines = []
  let used = Buffer.byteLength(head, 'utf8')
  let dropped = 0
  for (const entry of newestFirst) {
    const tags = entry.tags.length > 0 ? ` _(${entry.tags.join(', ')})_` : ''
    const line = `- ${entry.content}${tags}\n`
    const cost = Buffer.byteLength(line, 'utf8')
    if (used + cost > maxBytes) {
      dropped += 1
      continue
    }
    used += cost
    lines.push(line)
  }

  if (lines.length === 0) return ''
  const tail = dropped > 0 ? `\n_${dropped} older ${dropped === 1 ? 'entry' : 'entries'} omitted to stay within budget._\n` : ''
  return head + lines.join('') + tail
}

/**
 * Format one memory for tool output.
 *
 * @param {object} entry - a stored memory.
 * @returns {string} one readable line.
 */
function formatEntry(entry) {
  const tags = entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : ''
  return `${entry.id}${tags} ${entry.content}`
}

/**
 * Register the tool and the prompt section.
 *
 * @param {object} ctx - cordis context carrying `tools` and `systemPrompt`.
 * @param {object} [config] - plugin configuration.
 * @returns {void}
 */
export function apply(ctx, config) {
  const { dir, file } = resolveStore(config)
  const maxBytes = Number.isFinite(config?.maxBytes) ? Number(config.maxBytes) : DEFAULTS.maxBytes
  const maxEntries = Number.isFinite(config?.maxEntries) ? Number(config.maxEntries) : DEFAULTS.maxEntries

  // The prompt is assembled once per step, so this runs often. Re-read only when
  // the file actually changed; the signature is cheap and the parse is not.
  let cache = { signature: '', text: '' }
  const sectionText = () => {
    try {
      if (!existsSync(file)) {
        cache = { signature: 'absent', text: '' }
        return ''
      }
      const stat = statSync(file)
      const signature = `${stat.mtimeMs}:${stat.size}`
      if (signature !== cache.signature) {
        cache = { signature, text: renderSection(loadEntries(file), maxBytes) }
      }
      return cache.text
    } catch {
      // A broken store must not break prompt assembly.
      return ''
    }
  }

  ctx.systemPrompt.section({
    name: 'memory',
    order: SECTION_ORDER,
    // A function is re-evaluated at every assembly; a string would freeze at load.
    text: sectionText,
    interpolate: false,
  })

  ctx.tools.register({
    name: 'memory',
    description:
      'Persist a fact across sessions, or look one up. Memories are stored locally, are injected into every ' +
      'later session automatically, and the user can read and edit them. Save when the user states a durable ' +
      'preference, a stable fact about themselves, their projects or this machine, or a decision worth not ' +
      're-deciding — not for transient task state or anything already in a file you can read. Actions: ' +
      '`save` (content, optional tags) writes one self-contained sentence and returns its id; `search` ' +
      '(query) matches content and tags by substring, case-insensitive; `list` returns the newest entries; ' +
      '`forget` (id) deletes one.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['save', 'search', 'list', 'forget'],
          description: 'What to do: save a new fact, search, list the newest, or forget one by id.',
        },
        content: {
          type: 'string',
          description: 'For `save`: the fact, as one short self-contained sentence.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'For `save`: optional short labels, e.g. ["preference", "tooling"].',
        },
        query: {
          type: 'string',
          description: 'For `search`: substring to match against content and tags.',
        },
        id: {
          type: 'string',
          description: 'For `forget`: the id `save` or `list` returned.',
        },
        limit: {
          type: 'integer',
          description: 'For `search` or `list`: how many entries to return. Defaults to 10.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      // Standard JSON Schema: `required` is a sibling array of property names.
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { detail: { type: 'string' } },
        required: ['detail'],
      },
      render: (_args, value) => [{ type: 'text', text: value.detail }],
    },
    execute: async (args) => {
      const action = String(args.action ?? '')
      const entries = loadEntries(file)
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(100, Number(args.limit))) : 10

      if (action === 'save') {
        const content = String(args.content ?? '').trim().replace(/\s+/g, ' ')
        if (!content) throw new Error('memory: `content` is required when action is `save`')
        if (content.length > MAX_ENTRY_CHARS) {
          throw new Error(`memory: content is ${content.length} characters, over the ${MAX_ENTRY_CHARS} limit — split it into separate facts`)
        }
        const tags = Array.isArray(args.tags) ? args.tags.map((tag) => String(tag).trim()).filter(Boolean) : []
        const key = fold(content)
        const now = new Date().toISOString()
        const existing = entries.find((entry) => fold(entry.content) === key)
        let record
        let verb
        if (existing) {
          // Same fact restated: refresh it instead of storing a near-duplicate.
          existing.updatedAt = now
          existing.tags = [...new Set([...existing.tags, ...tags])]
          record = existing
          verb = 'updated'
        } else {
          record = { id: newId(entries), content, tags: [...new Set(tags)], createdAt: now, updatedAt: now }
          entries.push(record)
          verb = 'saved'
        }
        // Evict the oldest beyond the cap so the file cannot grow without bound.
        if (entries.length > maxEntries) {
          entries.sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))
          entries.splice(0, entries.length - maxEntries)
        }
        saveEntries(dir, file, entries)
        cache.signature = ''
        return { detail: `Memory ${verb} (${record.id}): ${record.content}` }
      }

      if (action === 'search') {
        const query = String(args.query ?? '').trim()
        if (!query) throw new Error('memory: `query` is required when action is `search`')
        const needle = query.toLowerCase()
        const hits = entries
          .filter((entry) => entry.content.toLowerCase().includes(needle) || entry.tags.some((tag) => tag.toLowerCase().includes(needle)))
          .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
          .slice(0, limit)
        if (hits.length === 0) return { detail: `No memory matches ${JSON.stringify(query)} (${entries.length} stored).` }
        return { detail: `${hits.length} of ${entries.length} memories match ${JSON.stringify(query)}:\n${hits.map(formatEntry).join('\n')}` }
      }

      if (action === 'list') {
        if (entries.length === 0) return { detail: 'No memories stored yet.' }
        const newest = [...entries].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, limit)
        return { detail: `${newest.length} of ${entries.length} memories, newest first:\n${newest.map(formatEntry).join('\n')}` }
      }

      if (action === 'forget') {
        const id = String(args.id ?? '').trim()
        if (!id) throw new Error('memory: `id` is required when action is `forget`')
        const index = entries.findIndex((entry) => entry.id === id)
        if (index === -1) throw new Error(`memory: no entry with id ${JSON.stringify(id)}`)
        const [removed] = entries.splice(index, 1)
        saveEntries(dir, file, entries)
        cache.signature = ''
        return { detail: `Forgot (${removed.id}): ${removed.content}` }
      }

      throw new Error(`memory: unknown action ${JSON.stringify(action)}`)
    },
  })
}
