import { describe, it, expect } from 'vitest'
import { resolveExtensionSource } from './extension-dir.ts'

describe('扩展目录的来源', () => {
  it('仓库里有构建产物 → 用它（开发机永远走这一档）', () => {
    const exists = (p: string) => p.endsWith('extension/.output/chrome-mv3')
    expect(resolveExtensionSource({ repoRoot: '/repo', exists })).toEqual({
      kind: 'repo',
      dir: '/repo/extension/.output/chrome-mv3',
    })
  })

  it('仓库产物不在场 → 落 npm 包，且拼上 chrome-mv3（包根里还有 package.json/index.js，整份装进 Chrome 会被判无效）', () => {
    const exists = () => false
    const resolvePkg = (spec: string) => `/node_modules/${spec}`
    expect(resolveExtensionSource({ repoRoot: '/repo', exists, resolvePkg })).toEqual({
      kind: 'npm',
      dir: '/node_modules/@streamapp/chrome-extension/chrome-mv3',
    })
  })

  it('两档都没有 → undefined（不许编一个路径出来）', () => {
    const exists = () => false
    const resolvePkg = () => {
      throw new Error('MODULE_NOT_FOUND')
    }
    expect(resolveExtensionSource({ repoRoot: '/repo', exists, resolvePkg })).toBeUndefined()
  })

  it('仓库目录在、但产物没构建 → 也算不在场（别把一个空目录当扩展装进去）', () => {
    const exists = (p: string) => p.endsWith('/repo/extension')
    const resolvePkg = () => {
      throw new Error('MODULE_NOT_FOUND')
    }
    expect(resolveExtensionSource({ repoRoot: '/repo', exists, resolvePkg })).toBeUndefined()
  })
})
