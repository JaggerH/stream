import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mountSkillRoutes } from './skills-routes.ts'
import { SHIPPED_SKILLS, SKILLS_ROOT_REL, landingName } from '../skills/shipped.ts'

let root = ''
let app: Hono
const first = () => SHIPPED_SKILLS[0]!.name

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stream-skill-routes-'))
  for (const { name } of SHIPPED_SKILLS) {
    const dir = join(root, 'src-root', SKILLS_ROOT_REL, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n`)
  }
  app = new Hono()
  // home 是注入的：这条线会往 `~/.claude/skills` 写东西，测试绝不碰真的家目录。
  mountSkillRoutes(app, {
    sourceRoot: join(root, 'src-root'),
    dataDir: join(root, 'data'),
    home: join(root, 'home'),
  })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const post = (path: string, body?: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })

describe('GET /api/skills', () => {
  it('装之前：列得出有哪几份、副本目录在哪，两个 host 都是空的', async () => {
    const body = (await (await app.request('/api/skills')).json()) as {
      shipped: { name: string }[]
      dir: string
      hosts: { host: string; landings: unknown[] }[]
    }
    expect(body.shipped.map((s) => s.name)).toEqual(SHIPPED_SKILLS.map((s) => s.name))
    expect(body.dir).toBe(join(root, 'data', 'skills'))
    expect(body.hosts.map((h) => h.host)).toEqual(['claude-code', 'codex'])
    expect(body.hosts.every((h) => h.landings.length === 0)).toBe(true)
  })
})

describe('POST /api/skills/install', () => {
  it('物化 + 链接一趟做完，回执里每一份都有落点', async () => {
    const res = await post('/api/skills/install')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { hosts: { landings: { mode?: string; path: string }[] }[] }
    for (const h of body.hosts) {
      expect(h.landings.map((l) => l.mode)).toEqual(SHIPPED_SKILLS.map(() => 'link'))
    }
    expect(existsSync(join(root, 'home/.claude/skills', landingName(first()), 'SKILL.md'))).toBe(true)
    expect(existsSync(join(root, 'home/.agents/skills', landingName(first()), 'SKILL.md'))).toBe(true)
  })

  // 两处各拼各的会在 Windows 上给出 `…\data/skills` 和 `…\data\skills` 两个样子，
  // 排查时看起来像两个目录（活体 2026-09-05 win-test 真出现过）。
  it('install 回执里的 dir 与 GET 报的**逐字符相同**', async () => {
    const installed = (await (await post('/api/skills/install')).json()) as { dir: string }
    const got = (await (await app.request('/api/skills')).json()) as { dir: string }
    expect(got.dir).toBe(installed.dir)
  })

  it('只装一个 host', async () => {
    const body = (await (await post('/api/skills/install', { hosts: ['codex'] })).json()) as {
      hosts: { host: string }[]
    }
    expect(body.hosts.map((h) => h.host)).toEqual(['codex'])
    expect(existsSync(join(root, 'home/.claude/skills'))).toBe(false)
  })

  // 拼错的 host 名静默忽略，表现是"我明明装了、那边却没有"，而没有任何一处会说为什么。
  it('不认识的 host → 400，并说出认识哪些', async () => {
    const res = await post('/api/skills/install', { hosts: ['cursor'] })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('cursor')
  })

  it('源目录缺席 → 500，消息里点名那条路径（= 发行包漏拷了它）', async () => {
    rmSync(join(root, 'src-root', SKILLS_ROOT_REL, first()), { recursive: true, force: true })
    const res = await post('/api/skills/install')
    expect(res.status).toBe(500)
    expect(((await res.json()) as { error: string }).error).toMatch(/skill 缺席/)
  })

  it('装完再 GET，状态是现查出来的（不是启动快照）', async () => {
    await post('/api/skills/install')
    const body = (await (await app.request('/api/skills')).json()) as {
      hosts: { landings: { mode?: string }[] }[]
    }
    expect(body.hosts[0]!.landings.length).toBe(SHIPPED_SKILLS.length)
    // 用户在 Stream 之外删掉一个 → 下一次 GET 必须立刻反映
    rmSync(join(root, 'home/.claude/skills', landingName(first())), { recursive: true, force: true })
    const after = (await (await app.request('/api/skills')).json()) as {
      hosts: { landings: unknown[] }[]
    }
    expect(after.hosts[0]!.landings.length).toBe(SHIPPED_SKILLS.length - 1)
  })
})

describe('POST /api/skills/uninstall', () => {
  it('删掉自己建的，不碰用户自己放的同名目录', async () => {
    await post('/api/skills/install')
    const mine = join(root, 'home/.agents/skills', landingName(first()))
    rmSync(mine, { recursive: true, force: true })
    mkdirSync(mine, { recursive: true })
    writeFileSync(join(mine, 'SKILL.md'), '我自己写的')

    const body = (await (await post('/api/skills/uninstall')).json()) as {
      removed: string[]
      kept: { path: string }[]
    }
    expect(body.kept.map((k) => k.path)).toEqual([mine])
    expect(readFileSync(join(mine, 'SKILL.md'), 'utf8')).toBe('我自己写的')
    expect(existsSync(join(root, 'home/.claude/skills', landingName(first())))).toBe(false)
  })
})
