import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { latestFailureShots } from './failure-shots.ts'

const mk = (files: string[]): string => {
  const dir = mkdtempSync(join(tmpdir(), 'shots-'))
  for (const f of files) writeFileSync(join(dir, f), 'x')
  return dir
}

describe('latestFailureShots', () => {
  it('按时间戳倒序取最近 n 张，回绝对路径', () => {
    const dir = mk(['demo-1000.jpg', 'demo-3000.jpg', 'demo-2000.jpg'])
    expect(latestFailureShots(dir, 'demo', 2)).toEqual([join(dir, 'demo-3000.jpg'), join(dir, 'demo-2000.jpg')])
  })

  it('只认自己那个源的文件名，别人的与非 jpg 一律不算', () => {
    const dir = mk(['demo-1.jpg', 'demo-other-2.jpg', 'other-3.jpg', 'demo-4.png', 'demo.jpg'])
    expect(latestFailureShots(dir, 'demo', 5)).toEqual([join(dir, 'demo-1.jpg')])
  })

  it('local 里的正则元字符按字面比（`.` 不是通配）', () => {
    const dir = mk(['a.b-1.jpg', 'axb-2.jpg'])
    expect(latestFailureShots(dir, 'a.b', 5)).toEqual([join(dir, 'a.b-1.jpg')])
  })

  it('目录不存在 → 空数组，不抛', () => {
    expect(latestFailureShots(join(tmpdir(), 'no-such-dir-2026'), 'demo', 3)).toEqual([])
  })
})
