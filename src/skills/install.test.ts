// 用**真文件系统**（tmpdir）跑，不注入假 fs：这条线上要验的恰恰是符号链接的真实行为
// （链接建得出来吗、跟着目标变吗、悬空了还认不认得出是自己放的），假 fs 验的是我自己写的假。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, lstatSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installSkills, materializeSkills, skillStatus, uninstallSkills } from './install.ts'
import { SHIPPED_SKILLS, SKILLS_ROOT_REL, landingName, retiredSkillNames } from './shipped.ts'

let root = ''
const src = () => join(root, 'src-root')
const dataDir = () => join(root, 'data')
const home = () => join(root, 'home')
const first = () => SHIPPED_SKILLS[0]!.name

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stream-skills-'))
  for (const { name } of SHIPPED_SKILLS) {
    const dir = join(src(), SKILLS_ROOT_REL, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n第一版\n`)
  }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const materialize = () => materializeSkills({ sourceRoot: src(), dataDir: dataDir() })
const install = () => installSkills({ dataDir: dataDir(), home: home() })

describe('materialize', () => {
  it('把出货的每一份拷进 <dataDir>/skills/', () => {
    const { dir, names } = materialize()
    expect(dir).toBe(join(dataDir(), 'skills'))
    expect(names).toEqual(SHIPPED_SKILLS.map((s) => s.name))
    expect(readFileSync(join(dir, first(), 'SKILL.md'), 'utf8')).toContain('第一版')
  })

  it('源目录缺席就抛，并点名路径——「发行包漏拷了」和「这份是空的」必须长得不一样', () => {
    rmSync(join(src(), SKILLS_ROOT_REL, first()), { recursive: true, force: true })
    expect(() => materialize()).toThrow(/skill 缺席/)
  })

  it('整份重刷：上一版的残余文件不留下（两代混着被读到 = "改了没生效"）', () => {
    materialize()
    writeFileSync(join(dataDir(), 'skills', first(), '残余.md'), 'x')
    materialize()
    expect(existsSync(join(dataDir(), 'skills', first(), '残余.md'))).toBe(false)
  })
})

describe('install', () => {
  it('两个 agent 各自的目录里都建出落点，且是链接', () => {
    materialize()
    const hosts = install()
    expect(hosts.map((h) => h.host)).toEqual(['claude-code', 'codex'])
    expect(hosts[0]!.root).toBe(join(home(), '.claude/skills'))
    expect(hosts[1]!.root).toBe(join(home(), '.agents/skills'))
    for (const h of hosts) {
      for (const l of h.landings) {
        expect(l.mode, `${h.host}/${l.skill} 没建出来：${l.skipped}`).toBe('link')
        expect(lstatSync(l.path).isSymbolicLink()).toBe(true)
      }
    }
  })

  // 这一条就是整个设计的理由：升级只刷副本，两个 agent 手里同时变新。
  it('副本一改，两个落点读到的都是新的（漂移在结构上不可能）', () => {
    materialize()
    install()
    writeFileSync(join(dataDir(), 'skills', first(), 'SKILL.md'), '第二版')
    for (const rel of ['.claude/skills', '.agents/skills']) {
      const p = join(home(), rel, landingName(first()), 'SKILL.md')
      expect(readFileSync(p, 'utf8'), `${rel} 读到的还是旧的`).toBe('第二版')
    }
  })

  it('重复装是幂等的（换新，不叠加）', () => {
    materialize()
    install()
    const again = install()
    expect(again[0]!.landings.every((l) => l.mode === 'link')).toBe(true)
  })

  it('那个位置已经有用户自己的东西 → 跳过并说明，绝不覆盖', () => {
    materialize()
    const mine = join(home(), '.claude/skills', landingName(first()))
    mkdirSync(mine, { recursive: true })
    writeFileSync(join(mine, 'SKILL.md'), '我自己写的')
    const [cc] = install()
    const landing = cc!.landings.find((l) => l.skill === first())!
    expect(landing.skipped).toBeTruthy()
    expect(landing.mode).toBeUndefined()
    expect(readFileSync(join(mine, 'SKILL.md'), 'utf8')).toBe('我自己写的')
  })

  it('只装其中一个 host 时不碰另一个', () => {
    materialize()
    installSkills({ dataDir: dataDir(), home: home(), hosts: ['codex'] })
    expect(existsSync(join(home(), '.claude/skills', landingName(first())))).toBe(false)
    expect(existsSync(join(home(), '.agents/skills', landingName(first())))).toBe(true)
  })
})

describe('status', () => {
  it('装之前是空的，装之后每一份都报 link', () => {
    materialize()
    expect(skillStatus({ dataDir: dataDir(), home: home() })[0]!.landings).toEqual([])
    install()
    const [cc] = skillStatus({ dataDir: dataDir(), home: home() })
    expect(cc!.landings.map((l) => l.mode)).toEqual(SHIPPED_SKILLS.map(() => 'link'))
  })

  it('副本被删掉（悬空链接）仍然看得见——否则用户只会看到"skill 不见了"而查不出为什么', () => {
    materialize()
    install()
    rmSync(join(dataDir(), 'skills'), { recursive: true, force: true })
    const [cc] = skillStatus({ dataDir: dataDir(), home: home() })
    expect(cc!.landings.length).toBe(SHIPPED_SKILLS.length)
  })
})

describe('uninstall', () => {
  it('只删自己建的；用户手写的同名目录一个都不碰', () => {
    materialize()
    install()
    const mine = join(home(), '.agents/skills', landingName(first()))
    rmSync(mine, { recursive: true, force: true })
    mkdirSync(mine, { recursive: true })
    writeFileSync(join(mine, 'SKILL.md'), '我自己写的')

    const { removed, kept } = uninstallSkills({ dataDir: dataDir(), home: home() })
    expect(kept.map((k) => k.path)).toEqual([mine])
    expect(readFileSync(join(mine, 'SKILL.md'), 'utf8')).toBe('我自己写的')
    expect(removed).toContain(join(home(), '.claude/skills', landingName(first())))
    expect(existsSync(join(home(), '.claude/skills', landingName(first())))).toBe(false)
  })

  /**
   * **改名之后，用户机器上那份旧的必须消失。**
   *
   * 没有这条：从 `SHIPPED_SKILLS` 里删掉一个名字，`install` 不会写它、`uninstall` 也不会删它
   * ——谁都不回头看一眼那个已经不在名单里的名字，于是它永远留在用户的 `~/.claude/skills/` 里
   * 继续答问题。一份**旧名、旧范围**的 skill 比缺一份更坏：它看起来像个正经答案。
   */
  it('退役的落点在安装时被清掉，用户自己写的同名不动', () => {
    const retired = retiredSkillNames()[0]!
    materialize()
    install()
    // 造一个"上一版装过、现已退役"的落点：内容指向我们的副本目录，所以 `ours` 认得
    const copy = join(dataDir(), 'skills', retired)
    mkdirSync(copy, { recursive: true })
    writeFileSync(join(copy, 'SKILL.md'), '旧的')
    const landed = join(home(), '.claude/skills', landingName(retired))
    rmSync(landed, { recursive: true, force: true })
    symlinkSync(copy, landed, 'dir')
    expect(existsSync(landed)).toBe(true)

    install()
    expect(existsSync(landed)).toBe(false)
  })

  it('退役名下如果是用户自己写的，不动它', () => {
    const retired = retiredSkillNames()[0]!
    materialize()
    const mine = join(home(), '.claude/skills', landingName(retired))
    mkdirSync(mine, { recursive: true })
    writeFileSync(join(mine, 'SKILL.md'), '我自己写的')
    install()
    expect(readFileSync(join(mine, 'SKILL.md'), 'utf8')).toBe('我自己写的')
  })

  it('悬空的落点也收拾掉（副本先被删了的情况）', () => {
    materialize()
    install()
    rmSync(join(dataDir(), 'skills'), { recursive: true, force: true })
    const { removed } = uninstallSkills({ dataDir: dataDir(), home: home() })
    expect(removed.length).toBe(SHIPPED_SKILLS.length * 2)
  })
})
