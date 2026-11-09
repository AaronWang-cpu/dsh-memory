/**
 * Smoke test: mounts the plugin the way the Host would, then drives the tool and
 * the prompt section against a temporary store. No test framework and no
 * dependencies — run it with `node test/smoke.mjs`.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, name } from '../lib/index.js'

let failures = 0
let checks = 0

function ok(condition, label, extra = '') {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`)
  }
}

function equal(actual, expected, label) {
  ok(actual === expected, label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

/** Mount the plugin against a stub context, as the loader would. */
function mount(dir, config = {}) {
  const registered = new Map()
  const effects = []
  let section
  const ctx = {
    tools: {
      register: (definition) => {
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
    },
    systemPrompt: {
      section: (value) => {
        section = value
        return () => { section = undefined }
      },
    },
    // cordis runs the callback and keeps whatever disposer it returns for unload.
    effect: (callback) => {
      effects.push(callback())
      return () => {}
    },
  }
  apply(ctx, { dir, ...config })
  return { tool: registered.get('memory'), section, registered, effects, getSection: () => section }
}

const root = mkdtempSync(join(tmpdir(), 'dsh-memory-'))
const dir = join(root, 'memory')
const file = join(dir, 'memory.jsonl')

try {
  console.log('manifest')
  equal(name, 'dsh-memory', 'package name is the row id')
  ok(Array.isArray(inject) && inject.includes('tools') && inject.includes('systemPrompt'), 'injects tools and systemPrompt')

  const { tool, section } = mount(dir)
  console.log('registration')
  ok(tool !== undefined, 'registers the memory tool')
  equal(tool.parameters.required[0], 'action', 'required is a sibling array (standard JSON Schema)')
  ok(typeof section.text === 'function', 'section text is a function, so it refreshes per assembly')
  equal(sectionText(section), '', 'empty store contributes no section')

  console.log('save')
  const first = await tool.execute({ action: 'save', content: '  Prefers   Chinese  replies. ', tags: ['preference'] })
  ok(/^Memory saved \(([0-9a-f]{8})\)/m.test(first.detail), 'returns the new id', first.detail)
  const id = /\(([0-9a-f]{8})\)/.exec(first.detail)[1]
  ok(fileExists(file), 'writes the JSONL store')
  const stored = JSON.parse(readFileSync(file, 'utf8').trim())
  equal(stored.content, 'Prefers Chinese replies.', 'collapses whitespace before storing')
  equal(stored.tags.join(','), 'preference', 'keeps tags')

  console.log('deduplicate')
  const again = await tool.execute({ action: 'save', content: 'prefers chinese replies.', tags: ['style'] })
  ok(again.detail.startsWith('Memory updated'), 'a restated fact updates instead of duplicating', again.detail)
  equal(readFileSync(file, 'utf8').trim().split('\n').length, 1, 'still one line on disk')
  const merged = JSON.parse(readFileSync(file, 'utf8').trim())
  equal(merged.tags.sort().join(','), 'preference,style', 'merges tags on update')

  console.log('search and list')
  await tool.execute({ action: 'save', content: 'Uses pnpm for every JavaScript project.' })
  const found = await tool.execute({ action: 'search', query: 'pnpm' })
  ok(found.detail.includes('Uses pnpm'), 'search finds by substring', found.detail)
  const byTag = await tool.execute({ action: 'search', query: 'style' })
  ok(byTag.detail.includes('Prefers Chinese'), 'search matches tags', byTag.detail)
  const miss = await tool.execute({ action: 'search', query: 'kubernetes' })
  ok(miss.detail.startsWith('No memory matches'), 'a miss says so', miss.detail)
  const list = await tool.execute({ action: 'list', limit: 1 })
  ok(list.detail.includes('of 2 memories'), 'list caps at the limit and reports the total', list.detail)

  console.log('prompt section')
  const text = sectionText(section)
  ok(text.startsWith('# Memory'), 'renders under a Memory heading')
  ok(text.includes('Prefers Chinese replies.'), 'includes stored facts')
  ok(text.includes('_(preference, style)_'), 'renders tags')
  ok(text.includes('silently'), 'tells the model these are background, not requests')

  console.log('budget')
  const big = mount(join(root, 'big'), { maxBytes: 400 })
  for (let index = 0; index < 6; index += 1) {
    await big.tool.execute({ action: 'save', content: `Fact ${index}: ${'x'.repeat(80)}` })
  }
  const budgeted = sectionText(big.section)
  ok(Buffer.byteLength(budgeted, 'utf8') <= 400, 'stays within maxBytes', `${Buffer.byteLength(budgeted, 'utf8')} bytes`)
  ok(/older (entry|entries) omitted/.test(budgeted), 'says how many were omitted', budgeted.split('\n').pop())
  ok(budgeted.includes('- Fact'), 'still carries facts, not just a header')
  const cramped = mount(join(root, 'cramped'), { maxBytes: 20 })
  equal(sectionText(cramped.section), '', 'a budget below any usable header contributes nothing instead of a broken section')

  console.log('validation')
  const rejects = async (label, call) => {
    try {
      await call()
      ok(false, label, 'did not throw')
    } catch (error) {
      ok(error instanceof Error && error.message.startsWith('memory:'), label, error.message)
    }
  }
  await rejects('rejects save without content', () => tool.execute({ action: 'save' }))
  await rejects('rejects search without query', () => tool.execute({ action: 'search' }))
  await rejects('rejects forget without id', () => tool.execute({ action: 'forget' }))
  await rejects('rejects an unknown id', () => tool.execute({ action: 'forget', id: 'deadbeef' }))
  await rejects('rejects an unknown action', () => tool.execute({ action: 'explode' }))
  await rejects('rejects over-long content', () => tool.execute({ action: 'save', content: 'x'.repeat(2001) }))

  console.log('forget')
  const removed = await tool.execute({ action: 'forget', id })
  ok(removed.detail.startsWith('Forgot'), 'forgets by id', removed.detail)
  ok(!readFileSync(file, 'utf8').includes(id), 'removes it from disk')

  console.log('resilience')
  writeFileSync(file, `${readFileSync(file, 'utf8')}{ this is not json }\n`, 'utf8')
  const afterCorruption = await tool.execute({ action: 'list' })
  ok(afterCorruption.detail.includes('memories'), 'one malformed line does not disable the store', afterCorruption.detail)

  console.log('disposal')
  const disposable = mount(join(root, 'disposable'))
  ok(disposable.registered.has('memory'), 'tool is registered before unload')
  ok(disposable.getSection() !== undefined, 'section is registered before unload')
  for (const effect of disposable.effects) effect?.()
  ok(!disposable.registered.has('memory'), 'the effect disposer unregisters the tool')
  ok(disposable.getSection() === undefined, 'the effect disposer removes the prompt section')

  console.log('eviction')
  const small = mount(join(root, 'small'), { maxEntries: 2 })
  for (const content of ['one', 'two', 'three']) await small.tool.execute({ action: 'save', content })
  const capped = await small.tool.execute({ action: 'list', limit: 10 })
  ok(/of 2 memories/.test(capped.detail), 'honours maxEntries by evicting the oldest', capped.detail)
} finally {
  rmSync(root, { recursive: true, force: true })
}

function sectionText(section) {
  return typeof section.text === 'function' ? section.text({}) : section.text
}

function fileExists(path) {
  try {
    readFileSync(path)
    return true
  } catch {
    return false
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`${failures} FAILED`)
  process.exit(1)
}
