import { describe, it, expect } from 'vitest'
import { parseOutcome } from './outcome.ts'

describe('parseOutcome', () => {
  it('取 stdout 里最后一行 ::outcome::，解析成 TaskOutcome', () => {
    const r = parseOutcome({
      stdout: 'downloading...\n::outcome:: {"summary":"补了 3 天","detail":{"days":3}}\n',
      stderr: '', exitCode: 0, signal: null,
    })
    expect(r.ok).toBe(true)
    expect(r.outcome).toEqual({ summary: '补了 3 天', detail: { days: 3 } })
  })

  it('有多行 ::outcome:: 时取最后一行——任务可以边跑边报进度', () => {
    const r = parseOutcome({
      stdout: '::outcome:: {"summary":"第一步"}\n::outcome:: {"summary":"最终"}\n',
      stderr: '', exitCode: 0, signal: null,
    })
    expect(r.outcome.summary).toBe('最终')
  })

  it('没有 outcome 行且退出码 0 ⇒ 成功，但摘要如实说没报', () => {
    const r = parseOutcome({ stdout: 'done\n', stderr: '', exitCode: 0, signal: null })
    expect(r.ok).toBe(true)
    expect(r.outcome.summary).toBe('exit 0（任务没报 ::outcome::）')
  })

  it('退出码非 0 ⇒ 失败，摘要带 stderr 末尾', () => {
    const r = parseOutcome({
      stdout: '', stderr: 'line1\nTraceback: boom\n', exitCode: 2, signal: null,
    })
    expect(r.ok).toBe(false)
    expect(r.outcome.summary).toContain('exit 2')
    expect(r.outcome.summary).toContain('Traceback: boom')
  })

  it('stderr 开头的库警告噪声不进摘要，摘要取最后的异常行（活体：RequestsDependencyWarning 刷屏）', () => {
    const stderr = [
      '/usr/lib/python3/dist-packages/requests/__init__.py:10: RequestsDependencyWarning: urllib3 (2.2.3) or chardet (5.2.0) does not match the supported version',
      'Traceback (most recent call last):',
      '  File "crawl.py", line 42, in <module>',
      '    raise RuntimeError("feed unavailable")',
      'RuntimeError: feed unavailable',
    ].join('\n')
    const r = parseOutcome({ stdout: '', stderr, exitCode: 1, signal: null })
    expect(r.ok).toBe(false)
    expect(r.outcome.summary).toContain('RuntimeError: feed unavailable')
    expect(r.outcome.summary).not.toContain('RequestsDependencyWarning')
  })

  it('被信号杀死（超时）⇒ 失败，摘要点名信号', () => {
    const r = parseOutcome({ stdout: '', stderr: '', exitCode: null, signal: 'SIGKILL' })
    expect(r.ok).toBe(false)
    expect(r.outcome.summary).toContain('SIGKILL')
  })

  it('outcome 行是坏 JSON ⇒ 不当成功也不吞：退化成原文摘要', () => {
    const r = parseOutcome({ stdout: '::outcome:: {不是JSON\n', stderr: '', exitCode: 0, signal: null })
    expect(r.ok).toBe(true)
    expect(r.outcome.summary).toContain('::outcome:: 行解析失败')
  })

  it('summary 缺失或非字符串 ⇒ 退化，不让 undefined 进账本', () => {
    const r = parseOutcome({ stdout: '::outcome:: {"detail":{"a":1}}\n', stderr: '', exitCode: 0, signal: null })
    expect(typeof r.outcome.summary).toBe('string')
    expect(r.outcome.summary.length).toBeGreaterThan(0)
  })
})

describe('parseOutcome stderr 噪声过滤的边界', () => {
  it('stderr 只有警告（退出码非 0、无 traceback）时保留警告——有总比空强', () => {
    const r = parseOutcome({
      stdout: '', stderr: '/x/y.py:10: RequestsDependencyWarning: version mismatch', exitCode: 1, signal: null,
    })
    expect(r.ok).toBe(false)
    expect(r.outcome.summary).toContain('RequestsDependencyWarning')
  })
})
