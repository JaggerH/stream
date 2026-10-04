import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanPackages } from './scan.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'stream-pkg-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function writePkg(id: string, stream: Record<string, unknown>, files: Record<string, string> = {}) {
  const d = join(dir, id)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: `@streamapp/${id}`, version: '1.0.0', stream }))
  for (const [f, body] of Object.entries(files)) writeFileSync(join(d, f), body)
  return d
}

const MANIFEST_YAML = `
- id: demo-source
  title: Demo
  adapter: pansou
  params_schema: {}
  capabilities: [search]
  auth: { type: none }
  cadence_hint_seconds: 3600
`

describe('scanPackages', () => {
  it('returns [] for a missing directory', () => {
    expect(scanPackages(join(dir, 'nope'))).toEqual([])
  })

  it('throws (does not silently return []) when dir is actually a file (ENOTDIR)', () => {
    const filePath = join(dir, 'not-a-dir')
    writeFileSync(filePath, 'not a directory')
    expect(() => scanPackages(filePath)).toThrow()
  })

  it('loads packages sorted by folder name and records dir', () => {
    writePkg('bbb', { id: 'bbb' })
    const aDir = writePkg('aaa', { id: 'aaa' })
    const pkgs = scanPackages(dir)
    expect(pkgs.map((p) => p.id)).toEqual(['aaa', 'bbb'])
    expect(pkgs[0].dir).toBe(aDir)
  })

  it('skips subdirectories without a package.json', () => {
    mkdirSync(join(dir, 'not-a-package'), { recursive: true })
    writePkg('real', { id: 'real' })
    expect(scanPackages(dir).map((p) => p.id)).toEqual(['real'])
  })

  it('merges manifests.yaml into sources', () => {
    writePkg('withman', { id: 'withman' }, { 'manifests.yaml': MANIFEST_YAML })
    const pkg = scanPackages(dir)[0]
    expect(pkg.sources?.map((s) => s.id)).toEqual(['demo-source'])
  })

  it('refuses sources declared in both places', () => {
    writePkg(
      'dup',
      {
        id: 'dup',
        sources: [
          {
            id: 'inline',
            title: 'x',
            adapter: 'pansou',
            params_schema: {},
            capabilities: ['search'],
            auth: { type: 'none' },
            cadence_hint_seconds: 3600,
          },
        ],
      },
      { 'manifests.yaml': MANIFEST_YAML },
    )
    expect(() => scanPackages(dir)).toThrow(/both/)
  })

  it('refuses a leftover top-level yaml descriptor', () => {
    writeFileSync(join(dir, 'legacy.yaml'), 'id: legacy\n')
    expect(() => scanPackages(dir)).toThrow(/package\.json/)
  })

  it('still refuses leftovers when opts are given without leftovers (default stays throw)', () => {
    writeFileSync(join(dir, 'legacy.yml'), 'id: legacy\n')
    expect(() => scanPackages(dir, {})).toThrow(/package\.json/)
  })

  it("ignores top-level yaml and loads the rest when leftovers: 'ignore'", () => {
    writeFileSync(join(dir, 'unrelated.yaml'), 'anything: goes\n')
    writeFileSync(join(dir, 'other.yml'), 'anything: goes\n')
    writePkg('real', { id: 'real' })
    expect(scanPackages(dir, { leftovers: 'ignore' }).map((p) => p.id)).toEqual(['real'])
  })

  it('reports the offending package in parse errors', () => {
    const d = join(dir, 'broken')
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'package.json'), JSON.stringify({ stream: {} }))
    expect(() => scanPackages(dir)).toThrow(/broken\/package\.json/)
  })
})
