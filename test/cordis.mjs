/**
 * Mounts the plugin inside the real cordis runtime and checks the lifecycle a
 * stub cannot prove: that `ctx.plugin()` loads it, that both registrations land,
 * and that unloading removes them.
 *
 * Needs `@deepseek-ai/cordis` resolvable, which is true inside a DeepSeek
 * Harness installation and false in a bare CI checkout — so it skips instead of
 * failing there. Run it from a directory where the runtime is installed:
 *
 *   node test/cordis.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

let Context
try {
  ({ Context } = await import('@deepseek-ai/cordis'))
} catch {
  console.log('skipped: @deepseek-ai/cordis is not installed here')
  process.exit(0)
}

const plugin = await import(new URL('../lib/index.js', import.meta.url).href)

let failures = 0
const ok = (condition, label, extra = '') => {
  if (!condition) failures += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${!condition && extra ? ` — ${extra}` : ''}`)
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-cordis-'))
try {
  const ctx = new Context()
  const registered = new Map()
  let section

  ctx.provide('tools', {
    register(definition) {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  })
  ctx.provide('systemPrompt', {
    section(value) {
      section = value
      return () => { section = undefined }
    },
  })

  const fork = ctx.plugin(plugin, { dir })
  await new Promise((resolve) => setTimeout(resolve, 60))

  ok(registered.has('memory'), 'loads through ctx.plugin and registers the tool')
  ok(section !== undefined, 'registers the prompt section')
  ok(typeof section?.text === 'function', 'section text stays a function')

  const tool = registered.get('memory')
  if (tool) {
    const saved = await tool.execute({ action: 'save', content: 'Prefers pnpm over npm.' })
    ok(saved.detail.startsWith('Memory saved'), 'the tool runs inside the runtime', saved.detail)
    ok(section.text({}).includes('Prefers pnpm over npm.'), 'the saved fact reaches the prompt')
  }

  await fork.dispose()
  await new Promise((resolve) => setTimeout(resolve, 60))
  ok(!registered.has('memory'), 'unloading removes the tool registration')
  ok(section === undefined, 'unloading removes the prompt section')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\ncordis mount: PASS' : `\ncordis mount: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
