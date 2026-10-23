// @vitest-environment node
// ↑ 必须写在文件最前面，且必须是 node 不能吃 app/ 默认的 jsdom：jsdom 的 TextEncoder 产出的
//   不是真 Uint8Array，esbuild 启动时那条不变量检查会直接抛
//   「your JavaScript environment is broken」，测试连收集都进不去。
/**
 * 影视分包的**构建产物**守卫：播放器那一堆不许再回到开页必载的主 bundle 里。
 *
 * **为什么只能对产物断言、不能写成普通单测**：这次分包唯一的收益就是"主 bundle 里没有它了"，
 * 而 jsdom 测试跑的是源码模块图——`StreamPanel` 通过 `movieBundle.load` 拿到影视树，在测试里
 * 被 spy 换成直接 `import('./movie-entry.tsx')`，源码层面看起来和"根本没分包"一模一样，全绿。
 *
 * **最容易的假绿是什么**：IIFE/UMD 格式下 Rollup 没有跨 chunk 加载器，动态 `import()` 会
 * **静默内联回主文件**（`panelBundleLoader.ts` 头注记了实测：加 `React.lazy` 后体积几乎没变、
 * 没有任何报错）。也就是说"看起来分了、其实没分"是这条路上的默认失败模式，而它不报错。所以
 * 这里的判据是产物字节本身：主 bundle 里搜不搜得到播放器。
 *
 * 反向自证也必须有：同一个标记在**影视** bundle 里必须搜得到。否则标记一旦选错（比如被压缩
 * 器改名了），第一条断言就退化成"两边都没有"，永远绿。
 */
import { describe, it, expect } from 'vitest'
import { build } from 'vite'
import { stat, readFile, mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'

// 路径一律从本模块自己的位置推，不信 cwd：多 worktree 并行时 shell 的 cwd 会漂到别人那棵树。
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** ArtPlayer 往 DOM 里写的根类名。选它当标记是因为**类名字符串压缩器不会改**——
 *  变量名会被改成一个字母，字符串字面量不会。 */
const PLAYER_MARK = 'art-video-player'

/** 研究那棵树里的一句字面量（`ResearchRunDetail` 的返回键）。同样是字符串字面量，压缩器不改。
 *  它证的是"研究树整个不在主 bundle 里"——而真正贵的是它带进来的 lightweight-charts +
 *  react-dom/server（约 860KB，见 `research-entry.tsx` 头注），那两个没有好认的字符串。 */
const RESEARCH_MARK = '← 返回列表'

/** 主 bundle 的体积上限（字节）。分包前是 2,821,152，分包后 1,170,793——这道线卡在中间，
 *  播放器那 1.65MB 一旦被重新内联回来（比如有人把 `movieBundle.load` 换成 `React.lazy`，
 *  或者从主树里直接 import 了 `MovieChannel`）会当场撞线。
 *
 *  **量的必须是出货那份**：这里曾经在 vitest 的 `NODE_ENV=test` 下构建，产物是开发态 JSX
 *  （每个元素一次 `jsxDEV` + 一串绝对路径），同一份源码量出 1,682,498，而出货的是 1,293,360；
 *  更糟的是那个数跟仓库所在路径长短一起漂（worktree 红、CI 绿）。之前两次「撞线 → 抬线」
 *  （1_600_000 → 1_650_000 那次量的是 1,608,191）量的都是这份虚胖的产物。现在 `buildEntry`
 *  显式设 `NODE_ENV=production`（配置那头不是 production 会直接炸），线也按真实体积收回来：
 *  1,293,360 上面留约 100KB 给正常长功能，几百 KB 到 MB 级的回灌照样当场撞线。
 *  **继续按"撞线就抬"的节奏走就等于没有闸**，下次撞线仍要先量（长的是谁）再决定拆还是抬。 */
const MAIN_BYTES_MAX = 1_400_000

async function buildEntry(entryName: string, outFile: string): Promise<{ dir: string; js: string }> {
  const outDir = await mkdtemp(path.join(os.tmpdir(), `panel-split-${entryName}-`))
  const before = process.env.PANEL_ENTRY
  const nodeEnvBefore = process.env.NODE_ENV
  process.env.PANEL_ENTRY = entryName
  // vitest 里是 `test`：不改的话量到的是开发态 JSX 的产物，不是出货那份（见 MAIN_BYTES_MAX 注释）。
  process.env.NODE_ENV = 'production'
  try {
    await build({
      configFile: path.join(appRoot, 'vite.panel.config.ts'),
      root: appRoot,
      logLevel: 'silent',
      build: { outDir, emptyOutDir: true },
    })
  } finally {
    if (before === undefined) delete process.env.PANEL_ENTRY
    else process.env.PANEL_ENTRY = before
    if (nodeEnvBefore === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = nodeEnvBefore
  }
  return { dir: outDir, js: path.join(outDir, outFile) }
}

describe('面板分包的构建产物', () => {
  it('播放器只在影视 bundle 里，主 bundle 搜不到，且主 bundle 没胖回去', async () => {
    const main = await buildEntry('main', 'panel.js')
    const movie = await buildEntry('movie', 'panel-movie.js')
    try {
      const mainJs = await readFile(main.js, 'utf8')
      const movieJs = await readFile(movie.js, 'utf8')

      // 1) 反向自证先做：标记必须在影视那份里真的存在。它不存在的话下面那条是空转。
      expect(movieJs, `影视 bundle 里没有 ${PLAYER_MARK}——标记选错了，下面那条断言是假绿`)
        .toContain(PLAYER_MARK)

      // 2) 正题：开页必载的那一份里搜不到播放器。
      expect(mainJs.includes(PLAYER_MARK), `主 bundle 里仍含 ${PLAYER_MARK}：影视没有真的分出去`)
        .toBe(false)

      // 3) 体积闸门：字符串标记只能证明 ArtPlayer 本身出去了，证不了整棵影视树都出去了
      //    （海报墙、分集、资源查找、网盘解析没有一个好认的字符串）。体积是那一整坨的代理量。
      const bytes = (await stat(main.js)).size
      expect(bytes, `主 bundle ${bytes} 字节，超过 ${MAIN_BYTES_MAX}——多半是影视又被内联回来了`)
        .toBeLessThan(MAIN_BYTES_MAX)
    } finally {
      await rm(main.dir, { recursive: true, force: true })
      await rm(movie.dir, { recursive: true, force: true })
    }
  }, 300_000)

  it('研究树只在研究 bundle 里，主 bundle 搜不到', async () => {
    const main = await buildEntry('main', 'panel.js')
    const research = await buildEntry('research', 'panel-research.js')
    try {
      const mainJs = await readFile(main.js, 'utf8')
      const researchJs = await readFile(research.js, 'utf8')
      // 反向自证先做：标记必须在研究那份里真的存在，否则下面那条是空转。
      expect(researchJs, `研究 bundle 里没有 ${RESEARCH_MARK}——标记选错了，下面那条断言是假绿`)
        .toContain(RESEARCH_MARK)
      expect(mainJs.includes(RESEARCH_MARK), `主 bundle 里仍含 ${RESEARCH_MARK}：研究没有真的分出去`)
        .toBe(false)
    } finally {
      await rm(main.dir, { recursive: true, force: true })
      await rm(research.dir, { recursive: true, force: true })
    }
  }, 300_000)
})
