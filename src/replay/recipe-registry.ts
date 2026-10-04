export interface Packument {
  'dist-tags': Record<string, string>
  versions: Record<string, { version: string; dist: { tarball: string; integrity?: string } }>
}
/** registry 搜索结果收窄后的形状。npm 的 `/-/v1/search` 返回体又大又会变，
 *  这里只放前端真正消费的三个字段——上游多长出什么字段，都到不了调用方。 */
export interface RegistrySearchHit {
  name: string
  version: string
  description: string
}

export interface RegistryClient {
  packument(name: string): Promise<Packument>
  tarball(url: string): Promise<Buffer>
  /** 按关键词搜 recipe 包。`keywords:stream-recipe` 由这里**固定拼上**，registry 地址取
   *  构造时配好的那一个——调用方只能给一个查询词，给不了 URL、给不了 registry 主机。
   *  一个"帮我 fetch 这个地址"的接口等于给后端开了个 SSRF 口子；这里要的只是"按关键词
   *  搜 recipe 包"，接口就窄到只能干这件事。 */
  search(text: string): Promise<RegistrySearchHit[]>
}

export const OFFICIAL_REGISTRY = 'https://registry.npmjs.org'

/** 配的 registry 是不是镜像。是 → 返回一个指着官方源的客户端，给安装口做 `@streamapp/` 包的
 *  校验和核对（见 `recipe-package.ts` 的 TRUST_SIDECAR 头注）；不是 → undefined，安装口一次
 *  官方源请求都不多发。只比主机名：同一个官方源写成带尾斜杠 / 大写也不算镜像。 */
export function officialRegistryIfMirror(
  base = process.env.STREAM_NPM_REGISTRY || OFFICIAL_REGISTRY,
  fetchImpl: typeof fetch = fetch,
): RegistryClient | undefined {
  let host: string
  try {
    host = new URL(base).host.toLowerCase()
  } catch {
    host = ''
  }
  return host === new URL(OFFICIAL_REGISTRY).host ? undefined : npmRegistryClient(OFFICIAL_REGISTRY, fetchImpl)
}

/** 直打 registry HTTP API——不经 npm 客户端,install scripts 无从执行(npm 只当运输层)。
 *  base 可指镜像(npmmirror);默认官方源。 */
export function npmRegistryClient(
  base = process.env.STREAM_NPM_REGISTRY || OFFICIAL_REGISTRY,
  fetchImpl: typeof fetch = fetch,
): RegistryClient {
  const root = base.replace(/\/$/, '')
  return {
    async packument(name) {
      const res = await fetchImpl(`${root}/${name.replace(/\//g, '%2f')}`)
      if (!res.ok) throw new Error(`registry ${res.status} for ${name}`)
      return (await res.json()) as Packument
    },
    async tarball(url) {
      const res = await fetchImpl(url)
      if (!res.ok) throw new Error(`registry ${res.status} for tarball ${url}`)
      return Buffer.from(await res.arrayBuffer())
    },
    async search(text) {
      const q = `${text} keywords:stream-recipe`.trim()
      const res = await fetchImpl(`${root}/-/v1/search?text=${encodeURIComponent(q)}&size=50`)
      if (!res.ok) throw new Error(`registry ${res.status} for search`)
      const body = (await res.json()) as {
        objects?: Array<{ package?: { name?: string; version?: string; description?: string } }>
      }
      return (body.objects ?? []).flatMap((o) => {
        const p = o.package
        return p?.name && p.version
          ? [{ name: p.name, version: p.version, description: p.description ?? '' }]
          : []
      })
    },
  }
}
