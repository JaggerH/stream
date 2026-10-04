import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'opensource-export.sh')

function write(repo: string, path: string, content = 'fixture'): void {
  const target = join(repo, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
}

function makeRepo(files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), 'opensource-export-source-'))
  for (const [path, content] of Object.entries(files)) write(repo, path, content)
  execFileSync('git', ['init', '--quiet'], { cwd: repo })
  execFileSync('git', ['add', '--all'], { cwd: repo })
  execFileSync('git', ['-c', 'user.name=release-test', '-c', 'user.email=release@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd: repo })
  return repo
}

function run(repo: string, output: string): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync('bash', [SCRIPT, output], { cwd: repo, encoding: 'utf8', stdio: 'pipe' }) }
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string }
    return { code: err.status, out: `${err.stdout}${err.stderr}` }
  }
}

function textFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name)
    if (entry.isDirectory() && (entry.name === '.git' || entry.name === 'node_modules')) return []
    return entry.isDirectory() ? textFiles(path) : statSync(path).size < 2_000_000 ? [path] : []
  })
}

function isGitTree(root: string): boolean {
  try {
    return execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8' }).trim() === 'true'
  } catch {
    return false
  }
}

describe('opensource export', () => {
  it('exports tracked public sources, preserves shipped skills, and omits internal records and data', () => {
    const repo = makeRepo({
      'README.md': '# [public design](docs/superpowers/private.md)',
      'docs/NOTES.md': 'See `docs/superpowers/specs/private.md`, `openspec/changes/archive/private/tasks.md`, `docs/TODO.md`, and [rules](../AGENTS.md).',
      '.claude/skills/demo/SKILL.md': '# shipped skill',
      'docs/API.md': '# public cookbook',
      'docs/superpowers/private.md': 'internal process',
      'openspec/changes/archive/private/tasks.md': 'internal change',
      'data/live.db': 'live state',
    })
    const output = join(mkdtempSync(join(tmpdir(), 'opensource-export-output-')), 'tree')
    try {
      expect(run(repo, output).code).toBe(0)
      expect(readFileSync(join(output, 'README.md'), 'utf8')).toContain('public')
      expect(readFileSync(join(output, 'README.md'), 'utf8')).not.toContain('docs/superpowers')
      const notes = readFileSync(join(output, 'docs/NOTES.md'), 'utf8')
      for (const internal of ['docs/superpowers/', 'openspec/changes/archive/', 'docs/TODO.md', 'AGENTS.md']) {
        expect(notes).not.toContain(internal)
      }
      expect(readFileSync(join(output, '.claude/skills/demo/SKILL.md'), 'utf8')).toContain('shipped')
      expect(() => readFileSync(join(output, 'openspec/changes/archive/private/tasks.md'))).toThrow()
      expect(() => readFileSync(join(output, 'docs/superpowers/private.md'))).toThrow()
      expect(() => readFileSync(join(output, 'data/live.db'))).toThrow()
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(dirname(output), { recursive: true, force: true })
    }
  })

  it('keeps current specs and active public changes, but omits archived and release-internal changes', () => {
    const repo = makeRepo({
      'README.md': '# public',
      'openspec/specs/current/spec.md': '# Current contract',
      'openspec/changes/active/proposal.md': '# Active public work',
      'openspec/changes/archive/completed/tasks.md': '# Historical record',
      'openspec/changes/opensource-release/tasks.md': '# Release safety record',
    })
    const output = join(mkdtempSync(join(tmpdir(), 'opensource-export-openspec-')), 'tree')
    try {
      expect(run(repo, output).code).toBe(0)
      expect(readFileSync(join(output, 'openspec/specs/current/spec.md'), 'utf8')).toContain('Current contract')
      expect(readFileSync(join(output, 'openspec/changes/active/proposal.md'), 'utf8')).toContain('Active public work')
      expect(() => readFileSync(join(output, 'openspec/changes/archive/completed/tasks.md'))).toThrow()
      expect(() => readFileSync(join(output, 'openspec/changes/opensource-release/tasks.md'))).toThrow()
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(dirname(output), { recursive: true, force: true })
    }
  })

  it('rejects an exported configuration file and names the unsafe path', () => {
    const repo = makeRepo({ 'README.md': '# public', 'config.yaml': 'live-secret: no' })
    const output = join(mkdtempSync(join(tmpdir(), 'opensource-export-rejected-')), 'tree')
    try {
      const result = run(repo, output)
      expect(result.code).toBe(1)
      expect(result.out).toContain('config.yaml')
      expect(readFileSync(join(output, '.EXPORT_REJECTED'), 'utf8')).toBe('')
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(dirname(output), { recursive: true, force: true })
    }
  })

  it('never exports the known real credential fragments or author machine paths', () => {
    const output = join(mkdtempSync(join(tmpdir(), 'opensource-export-pii-')), 'tree')
    const forbidden = [
      ['/home', 'jagger'].join('/'),
      ['C:', 'Users', 'Jagger'].join('\\'),
      ['alist-', '0ee959c6'].join(''),
      ['jDrnY5pR', 'Gd1uRinQNRUvMi'].join(''),
    ]
    try {
      // 从源码仓库跑时验证导出器；从干净 archive 跑时，当前树本身就是待验产物。
      // archive 没有 `.git`，不能要求它重新执行一个以 git archive 为入口的导出器。
      const tree = isGitTree(process.cwd()) ? output : process.cwd()
      if (tree === output) expect(run(process.cwd(), output).code).toBe(0)
      const matches = textFiles(tree).flatMap(path => {
        const content = readFileSync(path, 'utf8')
        return forbidden.filter(needle => content.includes(needle)).map(needle => `${path}: ${needle}`)
      })
      expect(matches).toEqual([])
    } finally {
      rmSync(dirname(output), { recursive: true, force: true })
    }
  })

  it('does not ship the withdrawn proprietary Meituan capability integration', () => {
    const output = join(mkdtempSync(join(tmpdir(), 'opensource-export-meituan-')), 'tree')
    const forbidden = [
      ['@streamapp/', 'meituan'].join(''),
      ['meituan', 'login'].join('_'),
      ['meituan', 'coupons'].join('_'),
      ['meituan', 'search'].join('_'),
      ['meituan', 'order'].join('_'),
      ['Work', 'Buddy'].join(''),
    ]
    try {
      // `git archive` deliberately omits .git. Inside the exported tree the
      // current directory is already the release candidate to scan.
      const tree = isGitTree(process.cwd()) ? output : process.cwd()
      if (tree === output) expect(run(process.cwd(), output).code).toBe(0)
      const matches = textFiles(tree).flatMap(path => {
        const content = readFileSync(path, 'utf8')
        return forbidden.filter(needle => content.includes(needle)).map(needle => `${path}: ${needle}`)
      })
      expect(matches).toEqual([])
    } finally {
      rmSync(dirname(output), { recursive: true, force: true })
    }
  })
})
