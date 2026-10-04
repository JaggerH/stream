// 三道闸，守的是同一种**静默**缺陷：某份 skill 在 dev 形态下一直在（源码树里 `.claude/skills/`
// 就是它的家），发行包里没有——于是"用户说找不到"而我们本地怎么都复现不了。09-04 那次
// 「发行包漏拷 persona 目录」是一模一样的形状：本地全绿，只有真装一次 npm 包才现形。
//
// 所以这里不验行为，只验**清单**：谁该出货、出货的那些在不在两张构建清单里、有没有人加了
// 一份新 skill 却没回答它属于哪一边。
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { REPO_ONLY_SKILLS, SHIPPED_SKILLS, SKILLS_ROOT_REL, landingName, retiredSkillNames, shippedSkillNames } from './shipped.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8')

describe('出货名单', () => {
  it('至少出一份——否则下面几条在空转', () => {
    expect(SHIPPED_SKILLS.length).toBeGreaterThan(0)
  })

  it.each(SHIPPED_SKILLS)('$name 的 SKILL.md 带 name + description（缺了就是装了也不会被触发）', ({ name }) => {
    // 两个 agent 都靠 frontmatter 的 description 判断"什么时候用它"。缺 description 的 skill
    // 装进去是死的：它在，但永远不会被选中，而**没有任何一处会报错**。
    const md = read(`${SKILLS_ROOT_REL}/${name}/SKILL.md`)
    const fm = md.split('---')[1] ?? ''
    expect(fm, `${name}: 缺 name:`).toMatch(/^\s*name:\s*\S+/m)
    expect(fm, `${name}: 缺 description:`).toMatch(/^\s*description:\s*\S+/m)
  })

  it.each(SHIPPED_SKILLS)('$name 在 build-server.mjs 的拷贝清单里', ({ name }) => {
    expect(read('scripts/build-server.mjs')).toContain(`${SKILLS_ROOT_REL}/${name}`)
  })

  it.each(SHIPPED_SKILLS)('$name 在 build-cli.mjs 的 SHIP 清单里', ({ name }) => {
    expect(read('scripts/build-cli.mjs')).toContain(`${SKILLS_ROOT_REL}/${name}`)
  })

  // 这一条是"不依赖人记性"的那一环：加一份新 skill 时必须回答它属于哪一边。
  it('两份名单的并集 == `.claude/skills/` 里实际的目录', () => {
    const onDisk = readdirSync(join(repoRoot, SKILLS_ROOT_REL), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
    const declared = [...SHIPPED_SKILLS.map((s) => s.name), ...REPO_ONLY_SKILLS.map((s) => s.name)].sort()
    expect(declared, '有 skill 没被任何一份名单认领——它该出货还是只在仓库里成立？').toEqual(onDisk)
  })

  it('两份名单不重叠', () => {
    const shipped = new Set(SHIPPED_SKILLS.map((s) => s.name))
    expect(REPO_ONLY_SKILLS.filter((s) => shipped.has(s.name))).toEqual([])
  })

  it('每一项都写了理由——名字本身说明不了任何事', () => {
    for (const s of SHIPPED_SKILLS) expect(s.why.length, `${s.name} 的 why 太短`).toBeGreaterThan(8)
    for (const s of REPO_ONLY_SKILLS) expect(s.whyNot.length, `${s.name} 的 whyNot 太短`).toBeGreaterThan(8)
  })

  it('落点名带 stream- 前缀（不顶掉用户自己的同名 skill）', () => {
    expect(landingName('purchase-decision')).toBe('stream-purchase-decision')
  })

  /**
   * 一个名字**不能同时在出货和退役两张名单里**。撞上时的表现很隐蔽：`install` 先按退役名单把它
   * 清掉、再按出货名单把它写回去，**看起来一切正常**，只是每次安装都白做一次删除。改名时把新旧
   * 两个名字填错位就会这样（2026-09-07 改 write-recipe 时真发生过一次：全仓替换脚本把退役条目里
   * 那个**故意保留的旧名**也一起改了）。
   */
  it('出货与退役两张名单不撞名', () => {
    expect(shippedSkillNames().filter((n) => retiredSkillNames().includes(n))).toEqual([])
  })

  /** 退役的那些**不该还留在源码树里**——留着就说明改名只改了一半。 */
  it('退役的 skill 目录已经不在源码树里', () => {
    for (const name of retiredSkillNames()) {
      expect(existsSync(join(repoRoot, SKILLS_ROOT_REL, name)), name).toBe(false)
    }
  })
})

