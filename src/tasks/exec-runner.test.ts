import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runExternal } from './exec-runner.ts'

const NODE = process.execPath

describe('runExternal', () => {
  it('拿到任务自报的 outcome', async () => {
    const out = await runExternal({
      command: NODE,
      args: ['-e', `console.log('::outcome:: ' + JSON.stringify({ summary: '干完了', detail: { n: 2 } }))`],
    })
    expect(out).toEqual({ summary: '干完了', detail: { n: 2 } })
  })

  it('非零退出 ⇒ throw，消息里带得到 stderr', async () => {
    await expect(runExternal({
      command: NODE,
      args: ['-e', `console.error('boom'); process.exit(3)`],
    })).rejects.toThrow(/exit 3.*boom/s)
  })

  it('超时 ⇒ 杀掉并 throw', async () => {
    await expect(runExternal({
      command: NODE,
      args: ['-e', `setTimeout(() => {}, 60000)`],
      timeoutMs: 300,
    })).rejects.toThrow(/SIGKILL|超时/)
  })

  it('子进程接住 SIGTERM 自己善后退出 0 ⇒ 仍算超时失败，不是 completed', async () => {
    await expect(runExternal({
      command: NODE,
      args: ['-e', `process.on('SIGTERM', () => process.exit(0)); setTimeout(() => {}, 60000)`],
      timeoutMs: 300,
    })).rejects.toThrow(/超时/)
  })

  it('cwd 与 env 生效', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'exec-runner-'))
    const out = await runExternal({
      command: NODE,
      args: ['-e', `console.log('::outcome:: ' + JSON.stringify({ summary: process.cwd() + '|' + process.env.MY_FLAG }))`],
      cwd: dir,
      env: { MY_FLAG: 'yes' },
    })
    expect(out.summary).toContain('yes')
    expect(out.summary).toContain(dir.split('/').pop()!)
  })

  it('stdout/stderr 落到 logFile，供页面展开看末尾', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'exec-runner-'))
    const logFile = join(dir, 'nested', 'run.log')  // 目录不存在也要能落
    await runExternal({
      command: NODE,
      args: ['-e', `console.log('hello-stdout'); console.error('hello-stderr')`],
      logFile,
    })
    const text = readFileSync(logFile, 'utf8')
    expect(text).toContain('hello-stdout')
    expect(text).toContain('hello-stderr')
  })

  it('命令根本不存在 ⇒ throw，且消息点名那条命令', async () => {
    await expect(runExternal({ command: '/nonexistent/binary-xyz', args: [] }))
      .rejects.toThrow(/\/nonexistent\/binary-xyz/)
  })
})
