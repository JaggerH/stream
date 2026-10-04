// Regenerate app/src/lib/source-domains.ts — the namespace → site-domain map used for brand
// icons (https://icons.folo.is/<domain>). Reads the `url` field from every RSSHub namespace.ts.
//
//   RSSHUB_DIR=~/projects/RSSHub node scripts/gen-source-domains.mjs
//
// Run after pulling RSSHub (new namespaces / changed domains).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const RSSHUB = process.env.RSSHUB_DIR || join(homedir(), 'projects/RSSHub')
const routesDir = join(RSSHUB, 'lib/routes')
const outFile = join(dirname(fileURLToPath(import.meta.url)), '..', 'app/src/lib/source-domains.ts')

const map = {}
for (const ns of readdirSync(routesDir)) {
  let src
  try { src = readFileSync(join(routesDir, ns, 'namespace.ts'), 'utf8') } catch { continue }
  const url = src.match(/\burl:\s*['"`]([^'"`]+)['"`]/)
  const name = src.match(/\bname:\s*['"`]([^'"`]+)['"`]/)
  const d = url?.[1] ? url[1].replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim() : undefined
  if (d || name?.[1]) map[ns] = { d, n: name?.[1] }
}
const sorted = Object.fromEntries(Object.keys(map).sort().map((k) => [k, map[k]]))
const banner =
  `// AUTO-GENERATED from the RSSHub repo's lib/routes/<ns>/namespace.ts (\`url\` + \`name\`).\n` +
  `// namespace → { d: site domain (brand icon at https://icons.folo.is/<d>), n: platform name }.\n` +
  `// Regenerate with scripts/gen-source-domains.mjs (after pulling RSSHub).\n`
writeFileSync(outFile, banner + `export const SOURCE_META: Record<string, { d?: string; n?: string }> = ${JSON.stringify(sorted)}\n`)
console.log(`wrote ${Object.keys(sorted).length} namespaces → ${outFile}`)
