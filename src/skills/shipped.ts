/**
 * **哪几份 skill 跟着发行包走到用户手里，哪几份只在我们仓库里成立。**
 *
 * 这是一份具名清单，不是内联判断——本仓库里"只对某一层生效的名单"漏掉第二层的缺陷已经犯过
 * 五次，而这一处的静默表现是：某个 skill 在 dev 形态下一直在（源码树里有 `.claude/skills/`），
 * 发行包里没有，于是"用户说找不到"而我们本地怎么都复现不了（09-04 的 persona 目录漏拷就是
 * 这个形状，一模一样）。
 *
 * **加一份新 skill 时必须回答它属于哪一边**，答不出来 `shipped.test.ts` 就红（两份名单的并集
 * 必须等于目录里的实际条数）。判据在下面每一项的 `why` 里，别只填一个名字。
 *
 * 出货的那些同时要出现在两张构建清单里（`scripts/build-server.mjs` 与 `scripts/build-cli.mjs`），
 * 同样由测试钉着——漏了任一张的表现都是"发行包里没有它"，而 dev 全绿。
 */

/** 相对仓库根 / 资源根的 skill 目录。 */
export const SKILLS_ROOT_REL = '.claude/skills'

export interface ShippedSkill {
  /** 目录名（= `.claude/skills/<name>/`）。 */
  name: string
  /** 为什么它对一个**没有本仓库**的用户成立。 */
  why: string
}

/**
 * 随包出货、可以装进用户自己 agent 的 skill。
 *
 * 判据只有一条：**它讲的事，在一台只装了 npm 包的机器上做得到吗？** 讲"怎么改 Stream 的代码"
 * 的一律不出货——那种指令在用户机器上指向一个不存在的目录，比不给更坏，因为它看起来像个
 * 正经答案。
 */
export const SHIPPED_SKILLS: ShippedSkill[] = [
  { name: 'purchase-decision', why: '买什么值得——全程走 MCP 工具，不碰仓库' },
  { name: 'netdisk-library', why: '补齐剧集 / 追更 / 整理网盘目录——全程走 MCP 工具' },
  { name: 'drive-live-ui', why: '看/动此刻活着的页面——四个 cdp_* 工具，用户装了扩展就成立' },
  {
    name: 'share-recipes',
    why: '发布 / 安装 recipe 包——两侧都是用户自己做得到的事（npm publish + 装包那几个 API），自查改走 /api/recipes/local',
  },
  {
    name: 'write-recipe',
    why: '给 Stream 加一个自己的源——抓包走 cdp_*、recipe 落 <dataDir>/recipes/，两步都不需要仓库',
  },
  {
    name: 'stream-assistant',
    why: '在任何宿主里用 Stream 工具的通用纪律（派不派子 agent、不叙述成已完成）——纯提示，不碰仓库',
  },
  {
    name: 'onboard-source',
    // 出货前把只对仓库成立的那几格标了 `<sup>仓库</sup>`，并在开头立了一张两形态对照表：
    // 用户形态走得通 0 / 1 / 2 的 recipe 那一半 / 3–5，走不通的只有 rsshub-routes、
    // wiring.md、authoring-backend-image.md 和"给引擎加能力"。路由器不许把人派进后面那几格。
    why: '接入一个新源的判路入口——阶梯六级里用户形态走得通五级（第 1 级的容器由后端自己建，见 provisioner 头注）；走不通的四处已在 SKILL.md 里标成仓库专属',
  },
]

export interface RepoOnlySkill {
  name: string
  /** 为什么它**不能**出货。写清是哪一类：改我们的代码 / 我们仓库的流程 / 缺一条用户形态的路。 */
  whyNot: string
}

/** 只在本仓库里成立、不进发行包的 skill。 */
export const REPO_ONLY_SKILLS: RepoOnlySkill[] = [
  {
    name: 'diagnose-netdisk-match',
    whyNot: '产出物是往 src/netdisk/match-spec.test.ts 里加回归用例——用户机器上没有那个文件',
  },
  {
    name: 'todo-auto',
    whyNot: '我们仓库的无人值守流程（docs/TODO.md → worktree → 合并），与用户无关',
  },
  {
    name: 'stream-cron',
    whyNot: '互斥判定那张资源表点的是本仓的东西（Cockpit 的采集桥、我们自己的 configRef 账号），第 3 步的坑清单也一路指向 src/tasks/ 和 docs/ARCHITECTURE.md',
  },
  {
    name: 'rsshub-routes',
    whyNot: '写 RSSHub 路由要 RSSHub 自己的检出并往上游提 PR，不是装了 Stream 就能做的事',
  },
]

/** 出货名单里的目录名（顺序稳定，给构建脚本与测试用）。 */
export const shippedSkillNames = (): string[] => SHIPPED_SKILLS.map((s) => s.name)

/**
 * **出过货、后来改名或撤掉的 skill。** 安装与卸载都要顺手把它们从用户机器上清掉。
 *
 * 没有这份名单时，从 `SHIPPED_SKILLS` 里删掉一个名字**不会**让用户那份消失——`install` 只写
 * 当前名单里的，`uninstall` 也只删当前名单里的，于是旧的那份永远留在他的 `~/.claude/skills/`
 * 里继续答问题。**一份旧名、旧范围的 skill 比缺一份更坏**：它看起来像个正经答案，而它讲的
 * 那套已经不成立了。
 *
 * 这正是本文件头注说的那个形状（"只对某一层生效的名单漏掉第二层"）——名单管了"发什么"，
 * 没管"不再发什么"。
 *
 * 一条只需要活到"用户大概率已经装过一次新版"为止，之后可以删；删早了的代价只是他机器上多留
 * 一份孤儿。`why` 写清它是被谁取代的。
 */
export const RETIRED_SKILLS: Array<{ name: string; why: string }> = [
  {
    // 这个名字**故意是旧的**，别跟着改名脚本一起替换掉——它存在的全部意义就是记住那个已经
    // 不用了的名字，好去用户机器上把它清掉。
    name: 'browser-harvest',
    why: '2026-09-07 改名 write-recipe：域是"写一份可重放的 recipe 驱动界面"，浏览器只是其中一个面（桌面已经在跑，手机在路上），名字里的 browser 和 harvest 两个词都太窄',
  },
]

export const retiredSkillNames = (): string[] => RETIRED_SKILLS.map((s) => s.name)

/** 用户 agent 的落点目录名。**带前缀是故意的**：`~/.claude/skills/` 是用户自己的命名空间，
 *  而 Claude Code 的冲突解析是 personal 覆盖 project——撞上同名就等于我们悄悄顶掉了他项目里
 *  的 skill。代价是命令变长（`/stream-purchase-decision`），换来"永不顶掉用户自己的东西"。 */
export const landingName = (skill: string): string => `stream-${skill}`

/** 反过来：一个落点是不是我们放的。`uninstall` 只认这个前缀 + 指向我们副本的链接。 */
export const LANDING_PREFIX = 'stream-'
