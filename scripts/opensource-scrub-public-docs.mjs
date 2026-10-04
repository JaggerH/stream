#!/usr/bin/env node
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2]
if (!root) {
  console.error('usage: opensource-scrub-public-docs.mjs <export-dir>')
  process.exit(2)
}

function markdownFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return markdownFiles(path)
    return entry.isFile() && path.endsWith('.md') && statSync(path).size < 5_000_000 ? [path] : []
  })
}

const internalMarkdownLink = /\[([^\]]+)\]\((?:\.\.\/|\.\/)*(?:(?:docs\/)?superpowers\/|openspec\/changes\/(?:archive|opensource-release)\/|docs\/(?:research\/|POSITIONING\.md|ROADMAP\.md|TODO\.md)|(?:AGENTS|CLAUDE)\.md)[^)\s]*\)/g
const replacements = [
  [/(?:docs\/)?superpowers\/(?:specs|reports|plans)\/[^\s`)）]+/g, 'internal design record'],
  [/openspec\/changes\/(?:archive|opensource-release)\/[^\s`)）]+/g, 'internal change record'],
  [/docs\/(?:POSITIONING|ROADMAP|TODO)\.md/g, 'project planning record'],
  [/docs\/research\/[^\s`)）]+/g, 'research record'],
  [/\b(?:AGENTS|CLAUDE)\.md\b/g, 'CONTRIBUTING.md'],
  [/(?:docs\/)?superpowers\//g, 'internal design records/'],
]

for (const path of markdownFiles(root)) {
  const before = readFileSync(path, 'utf8')
  let after = before.replace(internalMarkdownLink, '$1')
  for (const [pattern, replacement] of replacements) after = after.replace(pattern, replacement)
  if (after !== before) writeFileSync(path, after)
}
