import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { parse as parseYaml } from 'yaml'
import { generateCaddyfile, generateCompose, generateDevOverride } from './compose.ts'
// 主路生成物到底装了什么,由它说了算(今天是空的:只有插件容器)。测试吃真的那一份,
// 不自己另写一个字面量——否则 cli.ts 里加回一个基础设施容器,这里不会有任何反应。
import { BASE_SERVICES } from './cli.ts'
import type { PluginDescriptor } from './types.ts'

/** Caddyfile.local.example is a hand-maintained seed (never generated), `import`-ed by the
 *  generated Caddyfile. Repo root is two levels up from src/plugins/. */
const CADDYFILE_LOCAL_EXAMPLE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'Caddyfile.local.example')

const douyin: PluginDescriptor = {
  id: 'Douyin_TikTok_Download_API',
  backend: { image: 'ghcr.io/jaggerh/video-service:latest', service: 'douyin-tiktok-download-api', port: 80, health: '/docs' },
  credentials: ['douyin.com'],
  normalizer: 'douyin',
}
const pansou: PluginDescriptor = {
  id: 'pansou',
  backend: { image: 'ghcr.io/fish2018/pansou:latest', port: 8888 },
  normalizer: 'pansou',
}
const inProcess: PluginDescriptor = { id: 'xhs', normalizer: 'xhs' } // no backend

const STREAM_OPTS = {
  stream: {
    backendPort: 4555,
    rsshubMount: '${RSSHUB_SRC:-/home/x/RSSHub}:/home/x/RSSHub:ro',
    nasMount: '${NAS_MUSIC:-/home/x/nas-music}:/nas-music',
  },
} as const

describe('generateCompose', () => {
  it('主路只有插件容器层：共享网络 + 每个 backend 一个服务，没有网关', () => {
    const doc = parseYaml(generateCompose([douyin, pansou, inProcess]))
    expect(doc.networks.stream).toBeTruthy()
    // backend.service wins over id; in-process plugin contributes no service.
    // 网关不在这里——后端原生跑在宿主上，它自己就是那扇门。
    expect(Object.keys(doc.services).sort()).toEqual(['douyin-tiktok-download-api', 'pansou'])
    expect(doc.services['douyin-tiktok-download-api'].image).toBe('ghcr.io/jaggerh/video-service:latest')
    expect(doc.services['douyin-tiktok-download-api'].networks).toEqual(['stream'])
    // backends publish a loopback random port for host-plugin-door feature
    expect(doc.services['douyin-tiktok-download-api'].ports).toEqual(['127.0.0.1::80'])
    // pansou's service name defaults to its id
    expect(doc.services.pansou.image).toBe('ghcr.io/fish2018/pansou:latest')
  })

  it('自托管旁支才有网关：单一发布口 + 依赖每个 backend', () => {
    const doc = parseYaml(generateCompose([douyin, pansou], STREAM_OPTS))
    const gw = doc.services.gateway
    expect(gw.image).toContain('caddy')
    expect(gw.ports).toEqual(['127.0.0.1:8900:80']) // the ONLY published host port
    expect(gw.volumes).toEqual(['./Caddyfile:/etc/caddy/Caddyfile:ro', './Caddyfile.local:/etc/caddy/Caddyfile.local:ro'])
    expect(gw.depends_on.sort()).toEqual(['douyin-tiktok-download-api', 'pansou'])
  })

  it('主路没有网关——即使插件后端一大堆（后端自己就是那扇门）', () => {
    const doc = parseYaml(generateCompose([douyin, pansou]))
    expect(doc.services.gateway).toBeUndefined()
  })

  it('自托管档也没 backend 可转时不出网关（一个 Caddy 站在那儿无处可转）', () => {
    const doc = parseYaml(generateCompose([inProcess], STREAM_OPTS))
    expect(doc.services.gateway).toBeUndefined()
  })

  it('emits a healthcheck from backend.health', () => {
    const doc = parseYaml(generateCompose([douyin]))
    const hc = doc.services['douyin-tiktok-download-api'].healthcheck
    expect(hc).toBeTruthy()
    expect(hc.test.join(' ')).toContain('/docs')
  })

  // 我们不控制第三方镜像里装了什么。抖音那个镜像 wget 和 curl 都没有（只有 python），
  // 于是探针恒 `wget: not found` → 容器永远 unhealthy → `up -d --wait` 卡死。探针必须逐个
  // 退让到镜像真有的那件工具上。
  it('健康探针不绑死在某一个工具上——wget/curl/python 三选一', () => {
    const cmd = parseYaml(generateCompose([douyin])).services['douyin-tiktok-download-api'].healthcheck.test.join(' ')
    expect(cmd).toContain('wget')
    expect(cmd).toContain('curl')
    expect(cmd).toContain('python')
  })

  it('emits `user` for a backend that declares one, and omits it otherwise', () => {
    const withUser: PluginDescriptor = {
      id: 'alist',
      backend: { image: 'openlistteam/openlist:latest', port: 5244, user: '0:0' },
    }
    const without: PluginDescriptor = { id: 'pansou', backend: { image: 'fjy/pansou:v1', port: 8888 } }
    const doc = parseYaml(generateCompose([withUser, without]))
    expect(doc.services['alist'].user).toBe('0:0')
    expect('user' in doc.services['pansou']).toBe(false)
  })

  it('emits a GPU reservation + named volume for a gpu backend', () => {
    const whisperAsr: PluginDescriptor = {
      id: 'mineru',
      backend: {
        image: 'stream-mineru:latest',
        port: 80,
        gpu: true,
        env: { WHISPER_MODEL: '/models/large-v3' },
        volumes: ['mineru-cache:/root/.cache'],
      },
    }
    const doc = parseYaml(generateCompose([whisperAsr]))
    const svc = doc.services['mineru']
    expect(svc.deploy.resources.reservations.devices[0]).toMatchObject({ driver: 'nvidia', capabilities: ['gpu'] })
    expect(svc.volumes).toEqual(['mineru-cache:/root/.cache'])
    expect(svc.environment).toEqual({ WHISPER_MODEL: '/models/large-v3' })
    // the bare-name volume source is declared at the top level so compose creates it
    expect(doc.volumes).toHaveProperty('mineru-cache')
  })

  it('emits a memory cap with swap disabled for a mem-limited backend', () => {
    const svc = parseYaml(
      generateCompose([{ id: 'mineru', backend: { image: 'x', port: 80, mem: '8G' } }])
    ).services['mineru']
    expect(svc.mem_limit).toBe('8G')
    // memswap_limit === mem_limit ⇒ zero swap allowance (no host swap-thrash on a runaway)
    expect(svc.memswap_limit).toBe('8G')
  })

  it('生成物里只有插件容器 —— 一个基础设施容器都没有', () => {
    // 别把"取登录态"用的基础服务加进来：它会让 docker 成为采集的硬依赖,而
    // 成为硬依赖的唯一原因。扩展改成直推后端之后它就没有位置了（别加回来）。
    const doc = parseYaml(generateCompose([douyin, pansou], BASE_SERVICES))
    expect(Object.keys(doc.services).sort()).toEqual(['douyin-tiktok-download-api', 'pansou'])
  })

  it('没有任何服务带 restart —— 会和 standby 的闲置回收打架（stop 完立刻被 docker 拉起来）', () => {
    const doc = parseYaml(generateCompose([douyin, pansou], BASE_SERVICES))
    const withRestart = Object.entries(doc.services as Record<string, { restart?: string }>)
      .filter(([, svc]) => svc.restart !== undefined)
    expect(withRestart).toEqual([])
  })

  it('is deterministic (sorted keys) regardless of plugin order', () => {
    expect(generateCompose([douyin, pansou])).toBe(generateCompose([pansou, douyin]))
  })

  it('emits ONE built image shared by backend + frontend, plus the data volume, when opts.stream is given', () => {
    const doc = parseYaml(generateCompose([douyin], STREAM_OPTS))
    const be = doc.services['serve-backend']
    expect(be.build).toBe('.') // built from the repo Dockerfile
    expect(be.image).toBe('stream-backend') // ...and tagged so the frontend can reuse it
    expect(be.expose).toEqual(['4555'])
    expect(be.environment.STREAM_PLUGIN_NETWORK).toBe('compose')
    expect(be.volumes).toContain('./config.yaml:/app/config.yaml')
    // **没有 serve-frontend**：那个容器跑的是 Vite、发的是老版 UI，已随它一起下线。界面现在
    // 住在后端发的对话工作台里，所以自托管只需要后端这一个（Caddy 的兜底也因此指向它）。
    expect(doc.services['serve-frontend']).toBeUndefined()
    // only the DB data volume is a top-level named volume; node_modules are anonymous (dev-only)
    expect(doc.volumes).toHaveProperty('stream-data')
    expect(doc.volumes).not.toHaveProperty('stream-node-modules')
  })

  it('emits no stream services without opts.stream', () => {
    const doc = parseYaml(generateCompose([douyin]))
    expect(doc.services['serve-backend']).toBeUndefined()
  })

  it('serve-backend 显式钉 STREAM_PORT=backendPort —— 后端默认口已经是那扇门(8900)，不钉就 502', () => {
    const doc = parseYaml(generateCompose([douyin], STREAM_OPTS))
    const be = doc.services['serve-backend']
    expect(be.environment.STREAM_PORT).toBe(String(STREAM_OPTS.stream!.backendPort))
    expect(be.expose).toEqual([String(STREAM_OPTS.stream!.backendPort)]) // expose 和绑定必须同一个数
  })

  it('serve-backend env 标记 in-network（STREAM_PLUGIN_NETWORK=compose）', () => {
    const yml = generateCompose([douyin], STREAM_OPTS)
    expect(yml).toContain('STREAM_PLUGIN_NETWORK: compose')
    expect(yml).not.toContain('STREAM_PLUGIN_GATEWAY: http://gateway')
  })

  it('mounts docker.sock into serve-backend only when a standby backend exists', () => {
    const standbyPlugin: PluginDescriptor = { id: 'voiceprint', backend: { image: 'i', port: 80, standby: { idleMinutes: 10 } } }
    const plainPlugin: PluginDescriptor = { id: 'pansou', backend: { image: 'j', port: 80 } }
    const withStandby = generateCompose([standbyPlugin, plainPlugin], STREAM_OPTS)
    expect(withStandby).toContain('/var/run/docker.sock:/var/run/docker.sock')
    const without = generateCompose([plainPlugin], STREAM_OPTS)
    expect(without).not.toContain('docker.sock')
  })

  it('每个 backend 发布 loopback 随机口(host 档数据面),publish 口保留', () => {
    const yaml = generateCompose([
      { id: 'mineru', backend: { image: 'asr:1', port: 9000 } },
      { id: 'alist', backend: { image: 'alist:1', port: 5244, publish: 5244 } },
    ] as unknown as PluginDescriptor[])
    expect(yaml).toContain('127.0.0.1::9000')
    expect(yaml).toContain('127.0.0.1::5244')
    expect(yaml).toContain('5244:5244')
  })

  // 生成物会被人 cat、会被误提交（真发生过：这个文件曾经被跟踪，而 .gitignore 那一行对
  // 已跟踪文件无效）。所以它里面**一个凭证都不能有**——申报了 credentials 的包也一样。
  it('申报了 credentials 的后端也不发任何凭证', () => {
    const yaml = generateCompose(
      [
        { id: 'a', backend: { image: 'i', port: 80 }, credentials: ['x.com'] },
        { id: 'b', backend: { image: 'i', port: 80 } },
      ] as never,
      {},
    )
    expect(yaml).not.toContain('STREAM_CREDENTIAL_TOKEN')
    expect(yaml).not.toMatch(/token/i)
  })
})

describe('generateCaddyfile', () => {
  it('Caddyfile 不再逐插件发 /_p handle_path（后端持有网关）', () => {
    const cf = generateCaddyfile([douyin, pansou, inProcess])
    expect(cf).not.toContain('handle_path /_p/')
  })

  it('always imports Caddyfile.local for routes outside the plugin set', () => {
    expect(generateCaddyfile([])).toContain('import Caddyfile.local')
    expect(generateCaddyfile([douyin])).toContain('import Caddyfile.local')
  })

  it('不发任何 /_p 路由 —— 后端自己拥有插件网关', () => {
    const cf = generateCaddyfile([douyin, pansou], BASE_SERVICES)
    expect(cf).not.toContain('douyin-tiktok-download-api')
    expect(cf).not.toContain('handle_path /_p/pansou')
  })
})

describe('Caddyfile.local.example (hand-maintained seed, imported by the generated Caddyfile)', () => {
  const seed = readFileSync(CADDYFILE_LOCAL_EXAMPLE, 'utf8')

  it('routes /_p/* to serve-backend (the backend owns the plugin gateway) BEFORE the bare catch-all', () => {
    expect(seed).toContain('handle /_p/* {\n\treverse_proxy serve-backend:4555\n}')
    // ordering matters: Caddy's `handle` family matches specificity, but keep /_p/* textually
    // ahead of the bare `handle {}` catch-all so a reader never mistakes the frontend as the
    // /_p owner. Without this route, /_p/* falls through /api and /ws and hits the frontend
    // catch-all — wrong (the frontend doesn't own the plugin gateway, serve-backend does).
    expect(seed.indexOf('handle /_p/*')).toBeLessThan(seed.indexOf('handle {'))
  })

  it('keeps /api and /ws routed to serve-backend, and the bare catch-all routed there too', () => {
    expect(seed).toContain('handle /api/* {')
    expect(seed).toContain('reverse_proxy serve-backend:4555')
    expect(seed).toContain('handle /ws {')
    // 兜底也指后端：界面住在它发的对话工作台里（没跑时它发一张带启动按钮的页）。
    expect(seed).toMatch(/handle \{\n\treverse_proxy serve-backend:4555\n\}/)
    expect(seed).not.toContain('serve-frontend')
  })
})

describe('generateDevOverride', () => {
  const douyinDev: PluginDescriptor = {
    id: 'Douyin_TikTok_Download_API',
    backend: {
      image: 'ghcr.io/jaggerh/video-service:latest',
      service: 'douyin-tiktok-download-api',
      port: 80,
      health: '/docs',
      dev: { image: 'python:3.11', mount: '${HOME}/src/video-service', command: 'uvicorn app.main:app --reload' },
    },
    normalizer: 'douyin',
  }

  it('emits base-image + bind-mount + reload command for plugins declaring backend.dev', () => {
    const doc = parseYaml(generateDevOverride([douyinDev]))
    const svc = doc.services['douyin-tiktok-download-api'] // keyed by backend.service, matching the base compose
    expect(svc.image).toBe('python:3.11')
    expect(svc.working_dir).toBe('/app') // default workdir
    expect(svc.volumes).toEqual(['${HOME}/src/video-service:/app'])
    expect(svc.command).toContain('--reload')
  })

  it('omits plugins without backend.dev (they keep their baked image)', () => {
    const doc = parseYaml(generateDevOverride([douyin, pansou])) // neither declares dev
    expect(doc.services).toEqual({})
  })

  it('overlays source-mount + reload on the backend (no image → ride the baked build)', () => {
    const doc = parseYaml(generateDevOverride([], STREAM_OPTS))
    const be = doc.services['serve-backend']
    expect(be.image).toBeUndefined() // inherits the base service's built image
    expect(be.command).toContain('tsx watch')
    expect(be.volumes).toContain('.:/app')
    expect(be.volumes).toContain('/app/node_modules') // anonymous vol shields baked deps
    // dev DB lives on the host, re-bound over the base's `stream-data` named volume (which merges
    // by target and would otherwise shadow host ./data → empty DB). Regression guard.
    expect(be.volumes).toContain('./data:/app/data')
    expect(be.volumes).toContain('${RSSHUB_SRC:-/home/x/RSSHub}:/home/x/RSSHub:ro')
    // 前端容器已随老版 UI 下线，overlay 里因此也没有它。
    expect(doc.services['serve-frontend']).toBeUndefined()
  })
})
