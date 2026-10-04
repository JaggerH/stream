import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { AudioArchive } from './archive.ts'

/**
 * 归档目录里的**孤儿文件**：盘上有、`asset` 表里查无此行。
 *
 * 它们从哪来：早期按别的规则命名的副本（后来重下成 flac 入库、旧的没人删）、
 * 系统垃圾（`Thumbs.db`）。归档层只管"我记下的那些"，在这之前**没有任何一处会回头
 * 看目录里多出来的东西**。
 *
 * **白名单不是洁癖，是这份报告有没有人看的分界线**：`.dupes-removed-*` 这类人为放的
 * 目录、`.put-*.part` 这类正在下载的临时文件、`Thumbs.db` 这类系统垃圾如果都算孤儿，
 * 报告就永远不为零，很快就没人看了；更糟的是 `apply` 会去删一个**正在写入**的下载。
 */

let dir: string
let arc: AudioArchive
let root: string

const touch = (rel: string, bytes = 'x') => {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, bytes)
  return p
}

/** 直接往库里插一行 asset（不经 `put`——这里验的是"盘 vs 库"的差集，不是入库链路）。 */
const registerAsset = (relPath: string) => {
  touch(relPath)
  ;(arc as unknown as { db: import('better-sqlite3').Database }).db
    .prepare("INSERT INTO asset (sha256, rel_path, format, quality_tier) VALUES (NULL, ?, 'flac', 4)")
    .run(relPath)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'arc-orphans-'))
  root = join(dir, 'files')
  mkdirSync(root, { recursive: true })
  arc = new AudioArchive(join(dir, 'a.db'), root)
})

afterEach(() => {
  arc.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('orphans: 盘 vs 库的差集', () => {
  it('库里记着的文件不算孤儿', () => {
    registerAsset('netease/A - Song.flac')
    const r = arc.orphans()
    expect(r.entries).toEqual([])
    expect(r.scanned).toBe(1)
  })

  it('盘上多出来的文件就是孤儿——默认只报不删', () => {
    registerAsset('netease/A - Song.flac')
    const stale = touch('netease/A,Song.m4a')
    const r = arc.orphans()
    expect(r.applied).toBe(false)
    expect(r.deleted).toBe(0)
    expect(r.entries.map((e) => e.relPath)).toEqual(['netease/A,Song.m4a'])
    expect(r.entries[0]?.outcome).toBe('would-delete')
    expect(existsSync(stale)).toBe(true)
  })

  it('apply:true 真删掉孤儿，库里记着的那份一个都不动', () => {
    registerAsset('netease/A - Song.flac')
    const stale = touch('netease/A,Song.m4a')
    const r = arc.orphans({ apply: true })
    expect(r.applied).toBe(true)
    expect(r.deleted).toBe(1)
    expect(r.entries[0]?.outcome).toBe('deleted')
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(join(root, 'netease/A - Song.flac'))).toBe(true)
  })

  it('扫到子目录里去——归档布局是 <platform>/<file>，但存量目录可能更深', () => {
    registerAsset('netease/A - Song.flac')
    touch('netease/old/deep/A - Song.mp3')
    expect(arc.orphans().entries.map((e) => e.relPath)).toEqual(['netease/old/deep/A - Song.mp3'])
  })

  it('孤儿带着体积，好让人看出这一轮要腾出多少盘', () => {
    registerAsset('netease/A - Song.flac')
    touch('netease/big.mp3', 'x'.repeat(1234))
    expect(arc.orphans().entries.find((e) => e.relPath === 'netease/big.mp3')?.sizeBytes).toBe(1234)
  })
})

/**
 * **归档根不一定归 Stream 独占。** 活体那份（用户自设的 NAS 音乐目录）里除了
 * Stream 写的 `netease/`，还住着用户自己的音乐库（`陈奕迅合集/`、`QQ音乐源文件/`）和群晖
 * 回收站 `#recycle/`。第一版判据是"整个 root 的差集"，对着它跑报出 **1221 个孤儿、约 15GB**，
 * 其中真正属于 Stream 的只有 8 个——`--apply` 会把用户的私人音乐库清掉。
 *
 * 判据因此收窄成：**只看 Stream 自己写过的顶层目录**（`asset.rel_path` 的第一段集合）。
 * 归档布局是 `<platform>/<artist> - <title>.<ext>`，Stream 从没往别的顶层目录写过东西，
 * 那里面的一切就不是它的账。
 */
describe('orphans: 只认 Stream 自己写过的顶层目录', () => {
  it('从没归档过的顶层目录整棵不看——那是用户自己的东西', () => {
    registerAsset('netease/A - Song.flac')
    touch('陈奕迅合集/十年.mp3')
    touch('#recycle/删掉的.mp3')
    const r = arc.orphans()
    expect(r.entries).toEqual([])
  })

  it('Stream 写过的那个目录里，多出来的照样是孤儿', () => {
    registerAsset('netease/A - Song.flac')
    touch('netease/A,Song.m4a')
    touch('陈奕迅合集/十年.mp3')
    expect(arc.orphans().entries.map((e) => e.relPath)).toEqual(['netease/A,Song.m4a'])
  })

  it('库里一行都没有 → 一个孤儿都不报，绝不退化成"整个 root 都是孤儿"', () => {
    touch('陈奕迅合集/十年.mp3')
    touch('netease/A - Song.flac')
    const r = arc.orphans({ apply: true })
    expect(r.entries).toEqual([])
    expect(existsSync(join(root, 'netease/A - Song.flac'))).toBe(true)
  })
})

describe('orphans: 白名单——不进列表，但要报出跳过了几个', () => {
  it('系统垃圾（Thumbs.db / .DS_Store）不算孤儿', () => {
    registerAsset('netease/A - Song.flac')
    touch('netease/Thumbs.db')
    touch('netease/.DS_Store')
    touch('netease/desktop.ini')
    const r = arc.orphans()
    expect(r.entries).toEqual([])
    expect(r.ignored).toBe(3)
  })

  it('人为放的目录（点开头，如 .dupes-removed-*）整棵跳过', () => {
    registerAsset('netease/A - Song.flac')
    touch('netease/.dupes-removed-20260801/A - Song.mp3')
    const r = arc.orphans()
    expect(r.entries).toEqual([])
    expect(r.ignored).toBe(1)
  })

  it('正在下载的临时文件（.put-*.part）绝不能被当成孤儿删掉', () => {
    registerAsset('netease/A - Song.flac')
    const inflight = touch('netease/.put-abc123.part')
    const r = arc.orphans({ apply: true })
    expect(r.entries).toEqual([])
    expect(existsSync(inflight)).toBe(true)
  })
})
