/**
 * code 包里直接调全局 `fetch` 的请求永远从主实例发出——绑到 NAS 的账号会悄悄从加州下单，
 * 而一切测试照样绿。包的出站只许经 `ctx.fetch`（或接收注入的 fetch 参数）。
 * 见 openspec/changes/device-execution/specs/device-http-fetch/spec.md。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { repoRoot } from './http/build-identity.ts'

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|mts|js|mjs)$/.test(name) && !/\.test\.|\.guard\./.test(name)) out.push(p)
  }
  return out
}

// 调用形状的裸 fetch：`await fetch(`、`return fetch(`、`= fetch(`、`=> fetch(`、作为实参 `(fetch(` / `, fetch(`，
// 把 fetch 当值用（`?? fetch`、`|| fetch`、`= fetch` 默认值），以及任何 `globalThis.fetch`。
// **不**按「前面不是点」判：adapter 的 `async fetch(...) {` 是方法声明，那样会被误拦。
// `ctx.fetch(`、`s.send(`、`typeof fetch` 不命中。
const BARE = /(?:\bawait|\breturn|=>|[=(,])\s*fetch\s*\(|(?:\?\?|\|\||=)\s*fetch\b(?!\s*\()|globalThis\.fetch\b/

/** 只剥 `/* *\/` 块和整行 `//` 注释：字符串里的 `//`（`'http://x'; await fetch(u)`）不能把后面的调用藏起来。 */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}
export const hasBareFetch = (src: string): boolean => BARE.test(stripComments(src))

// 只打本包在主实例上的后端容器 / 容器接管的文件：这些请求必须留在本机，路由到设备反而会 host-not-allowed。
// 往里加一条需要 reviewer 确认该文件永远不会碰外部主机。
const HOST_CONTAINER_ONLY = new Map<string, string>([
  ['packages/Douyin_TikTok_Download_API/adapter/adapter.ts', '只打本包在主实例上的后端容器，不该跟随设备'],
  ['packages/pansou/adapter.ts', '只打本包在主实例上的后端容器（withAwake 里的 baseUrl），不该跟随设备'],
  ['packages/alist/provision.ts', '只打本包在主实例上的后端容器，不该跟随设备'],
])

describe('code 包不直接调全局 fetch', () => {
  it('守卫自测：字符串里的 // 藏不住裸 fetch，ctx.fetch / typeof fetch 不误报', () => {
    expect(hasBareFetch("const u = 'http://x'; await fetch(u)")).toBe(true)
    expect(hasBareFetch('const f = () => fetch(u)')).toBe(true)
    expect(hasBareFetch('const f = o.fetchImpl ?? fetch')).toBe(true)
    expect(hasBareFetch('await ctx.fetch(u)')).toBe(false)
    expect(hasBareFetch('send: typeof fetch,')).toBe(false)
  })

  it('豁免清单里的文件都还在（过期豁免会失败）', () => {
    for (const rel of HOST_CONTAINER_ONLY.keys()) expect(existsSync(join(repoRoot, rel)), rel).toBe(true)
  })

  it('packages/** 源码里没有裸 fetch(', () => {
    const files = walk(join(repoRoot, 'packages'))
    const hits = files
      .map((f) => relative(repoRoot, f))
      .filter((rel) => !HOST_CONTAINER_ONLY.has(rel))
      .filter((rel) => hasBareFetch(readFileSync(join(repoRoot, rel), 'utf8')))
    expect(hits, '改用 ctx.fetch 或接收注入的 fetch 参数').toEqual([])
  })
})
