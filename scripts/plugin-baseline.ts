// scripts/plugin-baseline.ts — dump the loaded plugin descriptor set as stable JSON.
// Used by docs/superpowers/plans/2026-07-06-plugin-folderization.md (baseline + acceptance diff).
import { loadConfig } from '../src/bootstrap.ts'
import { loadPlugins } from '../src/plugins/loader.ts'

const config = loadConfig()
const plugins = loadPlugins(config.packages_dir).sort((a, b) => a.id.localeCompare(b.id))
process.stdout.write(JSON.stringify(plugins, null, 2) + '\n')
