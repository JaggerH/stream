/**
 * 库入口不读环境变量（openspec `embeddable-engine` D1）的牙。
 *
 * `createStream()` 要能在同一个进程里起多份、嵌进别的进程里用；任何一个可达模块直接读 `process.env`，就等于
 * 所有实例共用同一份「配置」，而且调用方看不见、改不了。环境变量只许在进程入口翻译（`src/config-env.ts`、
 * `serve.ts`、CLI），翻译成 `AppConfig` 的字段再递进来。
 *
 * 判据：从 `src/engine/index.ts` 顺着**运行期**的相对 import（静态 + 动态，`import type` 不算）走一遍，可达文件的
 * 代码里（注释不算）不许出现 `process.env`。今天还没改完的那些列在 `OFFENDERS` 里，**只减不增**：
 * - 新出现一个读环境的可达模块 → 红（要么翻译进 config，要么在这里写明为什么是进程级的）；
 * - 一个文件已经不读了却还在名单上 → 也红（名单得跟着缩，否则它会悄悄变成一张许可证）。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { repoRoot } from '../http/build-identity.ts'

const ENTRY = 'src/engine/index.ts'

/**
 * 还在读 `process.env` 的可达模块 → 归属（design 附录 A 的表）。归「进程」的等 `StreamRuntime`（任务 2.1）收走；
 * 归「实例」的要翻译进 `AppConfig.deployment`。
 */
const OFFENDERS: Record<string, string> = {
  'packages/Douyin_TikTok_Download_API/adapter/adapter.ts': '包代码：DOUYIN_API_URL，应改走 ctx.backendUrl / runtime config',
  'packages/pansou/adapter.ts': '包代码：PANSOU_URL，同上',
  'src/docparse/client.ts': '实例：MINERU_URL 回落，改由调用方传',
  'src/intervention/acp-client.ts': '进程：agent 子进程继承环境',
  'src/media/ffmpeg-bin.ts': '进程：ffmpeg 探测子进程继承环境',
  'src/packages/container-ops.ts': '进程：DOCKER_HOST（resolveDockerEndpoint）',
  'src/plugins/deprovision.ts': '进程：DOCKER_HOST（resolveDockerEndpoint）',
  'src/plugins/provision-wire.ts': '进程：DOCKER_HOST（resolveDockerEndpoint）',
  'src/plugins/gateway.ts': 'HTTP：STREAM_GATEWAY_PORT',
  'src/plugins/plugin-target.ts': '实例：STREAM_PLUGIN_NETWORK（pluginNetMode 的缺省参数）',
  'src/replay/desktop-driver.ts': '实例：STREAM_DESKTOP_SEE_TRACE',
  'src/replay/desktop-see.ts': '实例：STREAM_DESKTOP_SEE_TRACE',
  'src/replay/desktop-runner.ts': '实例：desktopStatusEnabled 的缺省参数',
  'src/replay/recipe-probe.ts': '实例：RECIPE_PROBE',
  'src/replay/recipe-registry.ts': '实例：STREAM_NPM_REGISTRY',
  'src/rsshub-client.ts': '进程：RSSHUB_PKG / CACHE_TYPE / worker 子进程环境（D4 的 RSSHub worker）',
  'src/rsshub-worker-log.ts': '进程：RSSHUB_WORKER_LOG_PATH',
  'src/voiceprint/engine-client.ts': '实例：VOICEPRINT_URL 回落，改由调用方传',
}

/** 运行期的模块说明符：`import … from`、`export … from`、裸 `import '…'`、`import('…')`。`import type` / `export type` 另判。 */
const SPECIFIER = /(?:^|[^\w$.])(?:(import|export)(\s+type)?\s[^;'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\))/g

/** 读环境的几种写法。`NODE_ENV` / `VITEST` 不算——那是运行时本身的身份，不是实例配置。 */
const READS_ENV = /\bprocess\s*(?:\.\s*env\b(?!\s*\.\s*(?:NODE_ENV|VITEST)\b)|\[\s*['"]env['"]\s*\])|\{\s*[^}]*\benv\b[^}]*\}\s*=\s*process\b/

/** 去掉注释：块注释整段、行注释到行尾（`://` 不算行注释，免得把 URL 后半截当注释吞了）。 */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1')
}

function resolveSpecifier(from: string, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined
  const p = resolve(dirname(from), spec)
  for (const c of [p, `${p}.ts`, join(p, 'index.ts'), p.replace(/\.js$/, '.ts')]) {
    if (existsSync(c) && statSync(c).isFile()) return c
  }
  return undefined
}

/** 从入口出发的运行期可达文件（仓库相对路径）。 */
export function reachableFrom(entry: string): string[] {
  const seen = new Set<string>()
  const queue = [resolve(repoRoot, entry)]
  while (queue.length) {
    const f = queue.pop()!
    if (seen.has(f)) continue
    seen.add(f)
    if (!/\.(ts|mts|js|mjs)$/.test(f)) continue
    for (const m of stripComments(readFileSync(f, 'utf8')).matchAll(SPECIFIER)) {
      if (m[2]) continue // import type / export type
      const r = resolveSpecifier(f, m[3] ?? m[4] ?? m[5])
      if (r) queue.push(r)
    }
  }
  return [...seen].map((f) => relative(repoRoot, f)).sort()
}

describe('库入口可达的模块不读 process.env', () => {
  const files = reachableFrom(ENTRY)
  const hits = files.filter((f) => READS_ENV.test(stripComments(readFileSync(join(repoRoot, f), 'utf8'))))

  // 走得到才有意义：解析一旦写坏，会安静地只走到入口自己，下面两条照样全绿。
  it('从入口走到了整个装配（bootstrap 与各域插件）', () => {
    expect(files).toContain('src/bootstrap.ts')
    expect(files).toContain('src/kernel/plugins/agent.ts')
    expect(files.length).toBeGreaterThan(400)
  })

  it('没有名单之外的读环境的模块', () => {
    expect(
      hits.filter((f) => !(f in OFFENDERS)),
      '库入口可达的模块不许读 process.env：把它翻译进 AppConfig.deployment（src/bootstrap.ts 的 deploymentFromEnv），由进程入口传进来',
    ).toEqual([])
  })

  it('名单上没有已经改好的（名单只减不增）', () => {
    expect(
      Object.keys(OFFENDERS).filter((f) => !hits.includes(f)),
      '这些文件已经不读 process.env（或不再可达）了，从 OFFENDERS 里删掉',
    ).toEqual([])
  })

  it('判据自证有牙：认得几种读法，放过注释、NODE_ENV 与 import type', () => {
    for (const s of ['const a = process.env.X', "process['env']", 'const { env } = process', 'f(process.env)']) {
      expect(READS_ENV.test(stripComments(s)), `应命中：${s}`).toBe(true)
    }
    for (const s of ['// process.env.X', '/** 不读 `process.env` */', "if (process.env.NODE_ENV === 'test') {}", 'const url = "http://x" // process.env']) {
      expect(READS_ENV.test(stripComments(s)), `应放行：${s}`).toBe(false)
    }
    const specs = [..."import type { A } from './a.ts'\nimport { b } from './b.ts'\nexport * from './c.ts'\nawait import('./d.ts')\nimport './e.ts'".matchAll(SPECIFIER)]
      .filter((m) => !m[2]).map((m) => m[3] ?? m[4] ?? m[5])
    expect(specs).toEqual(['./b.ts', './c.ts', './d.ts', './e.ts'])
  })
})
