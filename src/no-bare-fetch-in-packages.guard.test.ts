/**
 * code 包里直接调全局 `fetch` 的请求永远从主实例发出——绑到 NAS 的账号会悄悄从加州下单，
 * 而一切测试照样绿。包的出站只许经 `ctx.fetch`（或接收注入的 fetch 参数）。
 * 见 openspec/changes/device-execution/specs/device-http-fetch/spec.md。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
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

// 调用形状的裸 fetch：`await fetch(`、`return fetch(`、`= fetch(`、作为实参 `(fetch(` / `, fetch(`，
// 以及任何 `globalThis.fetch`。**不**按「前面不是点」判：adapter 的 `async fetch(...) {` 是方法声明，
// 那样会被误拦。`ctx.fetch(`、`s.send(` 前面是点或别的名字，不命中。
const BARE = /(?:\bawait|\breturn|[=(,])\s*fetch\s*\(|globalThis\.fetch\b/

describe('code 包不直接调全局 fetch', () => {
  it('packages/** 源码里没有裸 fetch(', () => {
    const files = walk(join(repoRoot, 'packages'))
    const hits = files
      .filter((f) => BARE.test(readFileSync(f, 'utf8').replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '')))
      .map((f) => relative(repoRoot, f))
    expect(hits, '改用 ctx.fetch 或接收注入的 fetch 参数').toEqual([])
  })
})
