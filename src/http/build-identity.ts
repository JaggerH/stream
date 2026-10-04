/**
 * 「此刻在 8900 上跑的，到底是哪一份代码？」——`/api/health` 用它自证。
 *
 * 存在的理由是一类**静默**缺陷：热重载漏掉一次改动时，页面正常、health 200、日志干净，而你改的
 * 每一行都没生效。这时「开关没通电」和「改了也没差别」长得一模一样——照着后者下结论就是错的
 * （已经因此白跑过一整轮 A/B 实测）。所以判据不能是"我改了、它应该重载了"，得是活体自己报出
 * 它跑的是哪个 commit、启动之后工作区又动过多少个文件。
 *
 * 这一口**不针对某一种失效方式**：不管 watcher 以后又坏出什么新花样，「进程启动后源码还在变」
 * 都会被这个数看见。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 仓库根：本文件在 `<root>/src/http/`，往上两级。worktree 里跑就是那个 worktree 的根。
 *
 * 导出是给测试用的：`countChangedSince` 的 roots 是**相对这里**解析的，而进程的 cwd 可以是别处
 * （`vitest --root <worktree>` 在主检出里起动就是这样）。测试要造夹具就得造在这个根下面，拿
 * `process.cwd()` 拼路径会写到另一棵树去、然后一个文件都数不到。
 */
export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 「随载荷出货的这份东西，此刻在哪个根下面」。
 *
 * **源码树和打包形态的根不是同一个**：dev 下 `repoRoot` 就是仓库根；打成 `server.mjs` 之后
 * 整个后端是一个文件，`import.meta.url` 指向资源目录，`../..` 算出来是资源目录的**上两级**
 * ——一个不存在的地方。而 `cli-entry.ts` 会把 cwd 切到资源目录，所以那一档 `process.cwd()`
 * 才是对的根。
 *
 * 判据是**那样东西在不在**，不是"我是不是打包形态"：后者要引一个环境标志，而标志会漏设、
 * 会说谎；前者自己就是答案。
 *
 * 这个函数存在的理由是**它已经被漏过一次**：扩展目录（`extension/.output/chrome-mv3`）早就
 * 按这个形状挑根了，而面板产物（`app/dist-panel`）没有——于是发行形态下 `/panel/*` 恒 404，
 * 工作台里报「bundle 加载失败（Stream 后端没起，或还没 build:panel）」，两句猜测都不是真因。
 * 内联的 `[repoRoot, cwd].find(...)` 搜不到、也钉不住；具名之后才有回补清单可扫。
 *
 * @param rel - 那样东西相对根的路径（如 `app/dist-panel`）。
 * @param roots - 候选根，默认 `[repoRoot, process.cwd()]`；注入点只为测试。
 * @param exists - 注入点，只为测试。
 * @returns 含有它的那个根；都没有就回第一个候选（让下游报一个指向源码树的 404，而不是指向别处）。
 */
export function shippedRoot(
  rel: string,
  roots: string[] = [repoRoot, process.cwd()],
  exists: (p: string) => boolean = existsSync,
): string {
  return roots.find((r) => exists(join(r, rel))) ?? roots[0] ?? repoRoot
}

/** 进程启动那一刻（模块首次装载 ≈ 进程起点，两者差的是毫秒级的 import 时间）。 */
const startedAtMs = Date.now()

/**
 * 拿 `Date.now()` 去和文件 mtime 比要留出余量：内核给 mtime 盖的是**粗时钟**，实测这台机器上
 * 文件 mtime 最多落后 `Date.now()` 约 12ms（200 次写的最坏值）。不留余量的话，紧贴启动那一瞬
 * 写下的改动会被漏数。宁可宽 1 秒（把启动前 1 秒的改动也算进来），也不要漏——这个数存在的意义
 * 就是**别静默**。
 */
const CLOCK_TOLERANCE_MS = 1000

/** tsx 会加载、因而"改了就该重载"的那几棵树。别加 `app/`——前端归 Vite HMR 管，跟后端进程无关。 */
const watchedTrees = ['src', 'shared', 'packages']

/**
 * `git rev-parse --short HEAD`，**任何失败都吞掉回 undefined**。
 *
 * 这条是硬要求，不是防御性编程的客套：`/api/health` 是 MCP 探针（`mcp/spawn-backend.ts`）的存活
 * 判据，也是免鉴权的 liveness 口。没装 git、不是 git 仓库、打包成 release 后 `.git` 根本不在——这些都**必须**只是
 * 少一个字段，绝不能让探活挂掉。health 挂了比漏重载严重得多。
 */
export function readCommit(cwd: string): string | undefined {
  try {
    const out = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const sha = out.trim()
    return sha || undefined
  } catch {
    return undefined
  }
}

/** 数一下这几棵树里 mtime 晚于 `sinceMs` 的 `.ts` 文件。找不到的目录跳过（worktree 可能没有 packages/）。 */
export function countChangedSince(roots: string[], sinceMs: number): number {
  let n = 0
  const walk = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // 目录不存在 / 没权限：跳过，这个数是提示，不值得为它抛错
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        walk(p)
      } else if (e.name.endsWith('.ts')) {
        try {
          if (statSync(p).mtimeMs > sinceMs) n += 1
        } catch {
          /* 扫描途中文件被删：不算数 */
        }
      }
    }
  }
  for (const r of roots) walk(join(repoRoot, r))
  return n
}

let commitCache: { value: string | undefined } | undefined
let dirtyCache: { at: number; value: number } | undefined

/** 扫一遍约 1000 个文件、几毫秒；探活会高频打这一口，所以缓存 5s。 */
const DIRTY_TTL_MS = 5000

export type BuildIdentity = {
  /** 进程启动时刻（ISO）。 */
  started_at: string
  /** 启动时所在的 commit；读不到就没有这个字段。 */
  commit?: string
  /**
   * 启动之后 mtime 又变过的 `.ts` 文件数。
   *
   * **它是提示，不是告警，别拿它写断言。** 这个仓库随时有好几条并行线在改工作区，别人未提交的
   * WIP 会照样计进来——所以 >0 的正常含义只是「活体跑的代码和工作区当前的代码不是同一份了」，
   * 要不要在意得看你改的是不是那几个文件。为 0 才是强信号（那是"确实一致"）。
   */
  dirty_since_start: number
}

/** `/api/health` 用的那一份：commit 只读一次并记住（HEAD 变了也不改——它答的是"我启动时是谁"）。 */
export function buildIdentity(): BuildIdentity {
  if (!commitCache) commitCache = { value: readCommit(repoRoot) }
  const now = Date.now()
  if (!dirtyCache || now - dirtyCache.at > DIRTY_TTL_MS) {
    dirtyCache = { at: now, value: countChangedSince(watchedTrees, startedAtMs - CLOCK_TOLERANCE_MS) }
  }
  return {
    started_at: new Date(startedAtMs).toISOString(),
    ...(commitCache.value ? { commit: commitCache.value } : {}),
    dirty_since_start: dirtyCache.value,
  }
}
