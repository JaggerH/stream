import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { manifestSchema } from '../../src/manifest/loader.ts'
import { makeRuntimeConfigResolver } from '../../src/kernel/plugins/runtime-config.ts'
import { missingRequiredRuntimeFields } from '../../src/manifest/runtime-config.ts'
import type { SourceManifest } from '../../src/manifest/types.ts'

/**
 * 「cf-whisper 这一档配没配好」由宿主按本 manifest 的 `required` 字段判（`conversions` 域）。
 * Workers AI 端点按账号寻址，没有 accountId 必然失败——所以它必须是 required，而且判据要和成员
 * **执行时**用同一个解析器（存储优先、空着回落部署环境变量），这里拿真 manifest + 真解析器钉三种情形。
 */
const MANIFESTS = fileURLToPath(new URL('./manifests.yaml', import.meta.url))
const cf = (parse(readFileSync(MANIFESTS, 'utf8')) as unknown[])
  .map((m) => manifestSchema.parse(m))
  .find((m) => m.id === 'cf-whisper')!

function missingWith(stored: Record<string, unknown>, env: Record<string, string | undefined>): string[] {
  const resolve = makeRuntimeConfigResolver({
    settings: { runtimeConfig: () => stored, rows: { has: () => false, resolve: () => ({}) } },
    env,
  })
  return missingRequiredRuntimeFields(cf.runtime_config, resolve(cf as unknown as SourceManifest))
}

describe('packages/cloudflare/manifests.yaml — cf-whisper 的配置完整性', () => {
  it('accountId 是 required（没有它端点必然失败）', () => {
    expect(cf.runtime_config?.fields.accountId?.required).toBe(true)
  })

  it('只在配置页填了 accountId → 不缺', () => {
    expect(missingWith({ accountId: 'acct' }, {})).toEqual([])
  })

  it('什么都没填 → 缺 accountId', () => {
    expect(missingWith({}, {})).toEqual(['accountId'])
  })

  it('只填环境变量 CLOUDFLARE_ACCOUNT_ID → 不缺', () => {
    expect(missingWith({}, { CLOUDFLARE_ACCOUNT_ID: 'acct' })).toEqual([])
  })
})
