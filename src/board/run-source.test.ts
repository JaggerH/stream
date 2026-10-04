import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { researchRunsFn, listRunIds, readRunManifest, artifactsDirOf } from './run-source.ts'

function makeArtifacts(): string {
  const dir = mkdtempSync(join(tmpdir(), 'artifacts-'))
  const mk = (id: string, over: Record<string, unknown> = {}) => {
    mkdirSync(join(dir, id))
    writeFileSync(join(dir, id, 'run.json'), JSON.stringify({
      schema: 'run/v1', id, name: `algo ${id}`, variant: null, tags: ['backtest'], params: {},
      status: 'success', metrics: { sharpe: 1.5 }, artifacts: [],
      created_at: '2026-06-07T12:00:15+00:00', finished_at: '2026-06-07T12:00:16+00:00', ...over,
    }))
  }
  mk('20260601-000000-aaaaaa')
  mk('20260607-000000-bbbbbb', { variant: 'BTC DTE21' })
  mkdirSync(join(dir, 'not-a-run')) // 无 run.json 的目录忽略
  return dir
}

const ctx = (dir: string) => ({ runtimeConfig: { artifactsDir: dir } })

describe('research-runs source', () => {
  it('每 run 一条 item:guid 稳定、标题带 variant、tag、指标摘要,新的在前', async () => {
    const dir = makeArtifacts()
    const items = await researchRunsFn(undefined, {}, ctx(dir)) as Array<Record<string, unknown>>
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      guid: 'research-run:20260607-000000-bbbbbb',
      title: 'algo 20260607-000000-bbbbbb · BTC DTE21',
      category: ['backtest'],
    })
    expect(String(items[0]!.description)).toContain('sharpe')
    // 再采一遍 guid 逐字相同 → 采集管线的 dedup-store 按 guid 挡重(已见 run 不重发)
    const again = await researchRunsFn(undefined, {}, ctx(dir)) as Array<Record<string, unknown>>
    expect(again.map((i) => i.guid)).toEqual(items.map((i) => i.guid))
  })

  it('item 不再带 link——详情由 research 频道的子路由拥有,深链拦截随之取消', async () => {
    const dir = makeArtifacts()
    const items = await researchRunsFn(undefined, {}, ctx(dir)) as Array<Record<string, unknown>>
    expect(items[0]).not.toHaveProperty('link')
  })

  it('artifactsDir 未配置 → 抛错(不静默空批)', async () => {
    await expect(researchRunsFn(undefined, {}, { runtimeConfig: {} })).rejects.toThrow(/artifactsDir/)
  })

  it('坏 run.json → 抛错点名文件路径(不造空成功)', async () => {
    const dir = makeArtifacts()
    mkdirSync(join(dir, '20260608-000000-cccccc'))
    writeFileSync(join(dir, '20260608-000000-cccccc', 'run.json'), '{broken')
    await expect(researchRunsFn(undefined, {}, ctx(dir))).rejects.toThrow(/20260608-000000-cccccc\/run\.json/)
  })

  it('listRunIds 降序且忽略无 run.json 目录;readRunManifest 拒非 run/v1', () => {
    const dir = makeArtifacts()
    expect(listRunIds(dir)).toEqual(['20260607-000000-bbbbbb', '20260601-000000-aaaaaa'])
    writeFileSync(join(dir, '20260601-000000-aaaaaa', 'run.json'), JSON.stringify({ schema: 'other/v9' }))
    expect(() => readRunManifest(dir, '20260601-000000-aaaaaa')).toThrow(/run\.json/)
  })
})

describe('artifactsDirOf', () => {
  it('成员 params 压过源级 runtimeConfig', () => {
    const dir = artifactsDirOf({ artifactsDir: '/from/params' }, { runtimeConfig: { artifactsDir: '/from/source' } })
    expect(dir).toBe('/from/params')
  })

  it('params 没给就落回源级 runtimeConfig', () => {
    expect(artifactsDirOf({}, { runtimeConfig: { artifactsDir: '/from/source' } })).toBe('/from/source')
  })

  it('两处都没有就抛错点名要填哪儿', () => {
    expect(() => artifactsDirOf({}, { runtimeConfig: {} })).toThrow(/artifactsDir 未配置/)
  })
})
