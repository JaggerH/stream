/**
 * widget CLI（openspec `widget-manifest`）：check 与 add。
 */
import { checkWidget } from './check.ts'
import { resolveDataDir } from '../bootstrap.ts'
import { loadConfig } from '../config-env.ts'
import * as fs from 'node:fs'
import * as path from 'node:path'

const args = process.argv.slice(2)
const cmd = args[0]

if (cmd === 'widget:check') {
  const dir = args[1]
  if (!dir) { console.error('usage: stream widget:check <dir>'); process.exit(1) }
  const output = await checkWidget(dir)
  for (const r of output.results) {
    console.log(r.ok ? `✓ ${r.rule}` : `✗ ${r.rule}: ${r.message || ''}`)
  }
  process.exit(output.ok ? 0 : 1)
} else if (cmd === 'widget:add') {
  const id = args[1]
  const dir = args[2]
  const deviceIdx = args.indexOf('--device')
  if (!id || !dir || deviceIdx < 0) { console.error('usage: stream widget:add <id> <dir> --device <name>'); process.exit(1) }
  const device = args[deviceIdx + 1]
  try {
    const output = await checkWidget(dir)
    if (!output.ok) {
      for (const r of output.results) {
        if (!r.ok) console.error(`✗ ${r.rule}: ${r.message || ''}`)
      }
      process.exit(1)
    }
    if (!device) { console.error('--device is required'); process.exit(1) }
    const config = loadConfig()
    const dataDir = resolveDataDir(config)
    const storePath = path.join(dataDir, 'widgets.json')
    let m: Record<string, any>
    try { m = JSON.parse(fs.readFileSync(storePath, 'utf8')) } catch { m = {} }
    m[id] = { dir, device }
    fs.writeFileSync(storePath, JSON.stringify(m, null, 2) + '\n', { mode: 0o600 })
    console.log(`Added widget "${id}" → ${dir} on ${device}`)
  } catch (e: any) {
    console.error(`Error: ${e.message}`)
    process.exit(1)
  }
} else {
  console.log('usage: stream widget:check <dir> | stream widget:add <id> <dir> --device <name>')
  process.exit(0)
}
