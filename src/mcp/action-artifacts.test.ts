import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { artifactExt, pruneArtifacts, spillArtifacts, ARTIFACT_RETENTION_MS } from './action-artifacts.ts'

const dir = () => mkdtempSync(join(tmpdir(), 'action-artifacts-'))

describe('spillArtifacts', () => {
  it('把声明为文件的 base64 字段写成文件，字段值原地换成绝对路径；扩展名取自 extFrom（冒号前）', () => {
    const d = dir()
    const bytes = Buffer.from('8BPS\x00\x01 fake psd')
    const items = [{ guid: 'run-1', format: 'jpg:0.8', bytes: String(bytes.length), file: bytes.toString('base64') }]
    expect(spillArtifacts(d, { file: { extFrom: 'format' } }, items)).toBe(1)
    const p = items[0].file
    expect(p.startsWith(d)).toBe(true)
    expect(p.endsWith('.jpg')).toBe(true)
    expect(readFileSync(p)).toEqual(bytes)
    // 别的字段一个都不碰
    expect(items[0].format).toBe('jpg:0.8')
  })

  it('字段缺席 / 不是字符串 → 跳过不写，缺不缺由 recipe 的 assert 说', () => {
    const d = dir()
    const items = [{ guid: 'a' }, { guid: 'b', file: 42 }] as Record<string, unknown>[]
    expect(spillArtifacts(d, { file: { ext: 'png' } }, items)).toBe(0)
    expect(readdirSync(d)).toEqual([])
  })

  it('artifactExt 只留字母数字，空 / 怪值退回 bin——扩展名来自页面，别让它拼出路径', () => {
    expect(artifactExt({ extFrom: 'format' }, { format: 'PNG' })).toBe('png')
    expect(artifactExt({ extFrom: 'format' }, { format: '../../x' })).toBe('x')
    expect(artifactExt({ extFrom: 'format' }, {})).toBe('bin')
    expect(artifactExt({ ext: 'psd' }, { format: 'png' })).toBe('psd')
  })
})

describe('pruneArtifacts', () => {
  it('删 mtime 早于保留期的文件，新的留下；目录不存在回 0', () => {
    const d = dir()
    const now = Date.now()
    writeFileSync(join(d, 'old.png'), 'x')
    writeFileSync(join(d, 'new.png'), 'y')
    const oldSec = (now - ARTIFACT_RETENTION_MS - 60_000) / 1000
    utimesSync(join(d, 'old.png'), oldSec, oldSec)
    expect(pruneArtifacts(d, ARTIFACT_RETENTION_MS, now)).toBe(1)
    expect(readdirSync(d)).toEqual(['new.png'])
    expect(pruneArtifacts(join(d, 'nope'))).toBe(0)
  })
})
