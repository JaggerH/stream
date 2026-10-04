import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { manifestSchema } from '../../src/manifest/loader.ts'
import pkg from './package.json' with { type: 'json' }

const MANIFESTS = fileURLToPath(new URL('./manifests.yaml', import.meta.url))
const list = (parse(readFileSync(MANIFESTS, 'utf8')) as unknown[]).map((m) => manifestSchema.parse(m))
const source = list.find((m) => m.id === 'article-firecrawl')!

describe('packages/firecrawl/manifests.yaml — article-firecrawl', () => {
  it('执行后端是本包代码槽位申报的那个 adapter', () => {
    expect(source).toBeDefined()
    expect(source.adapter).toBe('firecrawl')
    expect(pkg.stream.code.adapters).toContain(source.adapter)
  })

  // 漏了 output: object，梯子会把整个 `[{text}]` 数组当赢家交出去：成员其实成功了，调用方读
  // .text 却是 undefined，而且因为它"赢"了，后面的成员根本不会跑。
  it('产出是单个结果对象：声明 output: object', () => {
    expect(source.output).toBe('object')
  })

  it('钥匙那格的 ref 是 firecrawl，且 key 可选（keyless 能跑）', () => {
    expect(source.runtime_config?.ref).toBe('firecrawl')
    expect(source.runtime_config?.fields.apiKey?.type).toBe('secret')
    expect(source.runtime_config?.fields.apiKey?.required).toBe(false)
  })

  // 全局默认 25s 掐不住云端 JS 渲染
  it('成员超时给足', () => {
    expect(source.member_timeout_ms).toBeGreaterThanOrEqual(60_000)
  })
})
