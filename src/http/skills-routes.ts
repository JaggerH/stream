// src/http/skills-routes.ts — 「把 Stream 的 skill 装进我自己的 agent」那三个动作
// （spec 2026-09-05-skill-delivery-design §4.5）。
//
// **写用户的全局配置目录（`~/.claude/skills`、`~/.agents/skills`）是外向副作用**，所以：
// 只有显式 POST 才发生（后端启动时一次都不碰）、可撤销、且 uninstall 只删自己建的那些。
//
// 三口都**现查**，不缓存任何状态：用户完全可能在 Stream 之外动过那两个目录（他自己删一个、
// 装了另一份同名 skill），冻一份就会长期报一个不再成立的答案。
import { join } from 'node:path'
import type { Hono } from 'hono'
import {
  ALL_HOSTS,
  installSkills,
  materializeSkills,
  skillStatus,
  uninstallSkills,
  type SkillHost,
} from '../skills/install.ts'
import { SHIPPED_SKILLS } from '../skills/shipped.ts'

export interface SkillRoutesDeps {
  /** 含 `.claude/skills/` 的根（`shippedRoot('.claude/skills')`）。 */
  sourceRoot: string
  dataDir: string
  /** 用户 home。注入点：测试不该往真的 `~` 里写东西。 */
  home: string
}

/** body 里的 hosts 过滤成合法值；没给就是全部。**不认识的名字直接 400**——静默忽略一个
 *  拼错的 host 名，表现是"我明明装了 codex 那边却没有"，而没有任何一处会说为什么。 */
function parseHosts(raw: unknown): SkillHost[] | { error: string } {
  if (raw === undefined) return ALL_HOSTS
  if (!Array.isArray(raw)) return { error: 'hosts must be an array' }
  const bad = raw.filter((h) => !ALL_HOSTS.includes(h as SkillHost))
  if (bad.length) return { error: `unknown host(s): ${bad.join(', ')}（认识的只有 ${ALL_HOSTS.join(' / ')}）` }
  return raw as SkillHost[]
}

export function mountSkillRoutes(app: Hono, deps: SkillRoutesDeps): void {
  app.get('/api/skills', (c) =>
    c.json({
      shipped: SHIPPED_SKILLS,
      // 和 install 回执里那个 dir 必须**逐字符相同**——两处各拼各的（一处 join、一处字符串
      // 相加）会在 Windows 上给出 `…\data/skills` 和 `…\data\skills` 两个样子，排查时看起来
      // 像两个目录。活体（2026-09-05 win-test）真出现过。
      dir: join(deps.dataDir, 'skills'),
      hosts: skillStatus({ dataDir: deps.dataDir, home: deps.home }),
    }),
  )

  app.post('/api/skills/install', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const hosts = parseHosts((body as { hosts?: unknown }).hosts)
    if ('error' in hosts) return c.json({ error: hosts.error }, 400)
    try {
      // 物化和链接是一趟里的两步：分成两个动作，用户就有机会在"副本还没刷新"的状态下链接，
      // 装出一份旧的而两边都不报错。
      const { dir } = materializeSkills({ sourceRoot: deps.sourceRoot, dataDir: deps.dataDir })
      return c.json({ dir, hosts: installSkills({ dataDir: deps.dataDir, home: deps.home, hosts }) })
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
    }
  })

  app.post('/api/skills/uninstall', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const hosts = parseHosts((body as { hosts?: unknown }).hosts)
    if ('error' in hosts) return c.json({ error: hosts.error }, 400)
    return c.json(uninstallSkills({ dataDir: deps.dataDir, home: deps.home, hosts }))
  })
}
