import { describe, it, expect } from 'vitest'
import { resolveJobsFile } from './center.ts'

/**
 * `sidequest.jobs.js` 的定位。这条守卫存在的理由是一次真实故障：发行形态下按源码树布局
 * 往上两级，在一台全新 Windows 上解析成了 `C:\Users\sidequest.jobs.js`，Sidequest 起不来、
 * **任务中心静默降级**——后端 200、页面正常，只有日志里一行，而定时采集整个不跑。
 */
describe('sidequest.jobs.js 的定位', () => {
  it('发行形态：和 server.mjs 同目录那一份', () => {
    const dir = '/opt/stream'
    const exists = (p: string) => p === '/opt/stream/sidequest.jobs.js'
    expect(resolveJobsFile(dir, exists)).toBe('/opt/stream/sidequest.jobs.js')
  })

  it('源码树：本模块在 src/tasks/，仓库根在往上两级', () => {
    const dir = '/repo/src/tasks'
    const exists = (p: string) => p === '/repo/sidequest.jobs.js'
    expect(resolveJobsFile(dir, exists)).toBe('/repo/sidequest.jobs.js')
  })

  it('两个都在（源码树里正好也有同名文件）→ 取同目录那份，不去猜远处那个', () => {
    const dir = '/repo/src/tasks'
    const exists = () => true
    expect(resolveJobsFile(dir, exists)).toBe('/repo/src/tasks/sidequest.jobs.js')
  })

  it('都不在 → 回同目录那个路径，让报错指向我们期望的位置', () => {
    const dir = '/opt/stream'
    const exists = () => false
    // 绝不能回 `/opt/sidequest.jobs.js`——那个"往上两级"算出来的地方谁都没放过文件，
    // 报出来只会把排查的人带偏（真实故障里就是这么发生的）。
    expect(resolveJobsFile(dir, exists)).toBe('/opt/stream/sidequest.jobs.js')
  })
})
