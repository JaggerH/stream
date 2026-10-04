import { describe, it, expect, vi } from 'vitest'
import { makeExtPageDriver } from './ext-page.ts'
import type { ExtRawPage } from './ext-page.ts'
import { runAction } from './run-action.ts'
import type { PageDriver } from './page-driver.ts'

// ── setFiles：把浏览器所在机器上的本地文件放进 <input type=file> ─────────────────────
// 底层是 CDP `DOM.setFileInputFiles`（要 nodeId：getDocument → querySelector）。三种失败各报各的
// （选择器没命中 / 命中的不是文件输入框 / CDP 拒绝），都抛、不回 false——下一步各不相同。
// "放进去了"的证据是页面上 `el.files` 真有东西，不是 CDP 命令返回了。

function makeRaw(opts: {
  probe: unknown
  files?: unknown
  cdp?: (method: string, params?: unknown) => Promise<unknown>
}) {
  const evalExpr = vi.fn(async (expr: string) => {
    if (expr.includes('addEventListener')) return true // 挂 change 监听
    if (expr.includes('__streamSetFiles')) return opts.files ?? [] // 读抄下来的 files
    return opts.probe
  })
  const cdp = vi.fn(
    opts.cdp ??
      (async (method: string) => {
        if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
        if (method === 'DOM.querySelector') return { nodeId: 42 }
        return {}
      }),
  )
  return { raw: { tabId: 5, evalExpr, cdp } as unknown as ExtRawPage, cdp, evalExpr }
}

describe('ExtPageDriver.setFiles', () => {
  it('命中 <input type=file> → getDocument → querySelector → setFileInputFiles(nodeId, files)，回页面上的 files', async () => {
    const { raw, cdp } = makeRaw({
      probe: { found: true, tag: 'INPUT', type: 'file', multiple: true },
      files: [{ name: 'a.psd', type: '', size: 123 }],
    })
    const out = await makeExtPageDriver(raw).setFiles!('body > input[type=file]', ['C:\\x\\a.psd'])
    expect(out).toEqual([{ name: 'a.psd', type: '', size: 123 }])
    expect(cdp.mock.calls.map((c) => c[0])).toEqual(['DOM.getDocument', 'DOM.querySelector', 'DOM.setFileInputFiles'])
    expect(cdp.mock.calls[2][1]).toEqual({ files: ['C:\\x\\a.psd'], nodeId: 42 })
  })

  it('页面收到的全是 0 字节（路径不存在，CDP 不报错）→ 抛，提醒路径按浏览器机器解释', async () => {
    const { raw } = makeRaw({ probe: { found: true, tag: 'INPUT', type: 'file', multiple: true }, files: [{ name: 'nope.psd', type: '', size: 0 }] })
    await expect(makeExtPageDriver(raw).setFiles!('#f', ['C:\\nope.psd'])).rejects.toThrow(/0 字节.*WSL 路径/)
  })

  it('页面没收到 change（files 空）→ 抛，不当成功', async () => {
    const { raw } = makeRaw({ probe: { found: true, tag: 'INPUT', type: 'file', multiple: true }, files: [] })
    await expect(makeExtPageDriver(raw).setFiles!('#f', ['C:\\a.psd'])).rejects.toThrow(/没收到 change/)
  })

  it('选择器没命中 → 抛，一条 CDP 都不发', async () => {
    const { raw, cdp } = makeRaw({ probe: { found: false } })
    await expect(makeExtPageDriver(raw).setFiles!('#nope', ['C:\\x'])).rejects.toThrow(/没命中任何元素/)
    expect(cdp).not.toHaveBeenCalled()
  })

  it('命中的不是文件输入框 → 抛出它是什么', async () => {
    const { raw } = makeRaw({ probe: { found: true, tag: 'INPUT', type: 'text' } })
    await expect(makeExtPageDriver(raw).setFiles!('#q', ['C:\\x'])).rejects.toThrow(/<input type=text>/)
  })

  it('多个文件放进非 multiple 的输入框 → 抛', async () => {
    const { raw } = makeRaw({ probe: { found: true, tag: 'INPUT', type: 'file', multiple: false } })
    await expect(makeExtPageDriver(raw).setFiles!('#f', ['C:\\a', 'C:\\b'])).rejects.toThrow(/不是 multiple/)
  })

  it('CDP 拒了（路径不存在等）→ 原文带回来，并提醒路径按浏览器所在机器解释', async () => {
    const { raw } = makeRaw({
      probe: { found: true, tag: 'INPUT', type: 'file', multiple: true },
      cdp: async (method: string) => {
        if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
        if (method === 'DOM.querySelector') return { nodeId: 42 }
        throw new Error('Could not set file input files')
      },
    })
    await expect(makeExtPageDriver(raw).setFiles!('#f', ['/home/x/a.psd'])).rejects.toThrow(
      /DOM\.setFileInputFiles 被拒.*WSL 路径.*Could not set file input files/,
    )
  })
})

describe('runAction kind:setFiles', () => {
  it('缺 paths → 报缺哪个字段；driver 没这一格 → 说清是哪种 driver 才有', async () => {
    const withIt = { setFiles: vi.fn(async () => []) } as unknown as PageDriver
    await expect(runAction(withIt, { kind: 'setFiles', domain: 'a.test', selector: '#f' })).rejects.toThrow(/缺 paths/)
    const without = {} as PageDriver
    await expect(runAction(without, { kind: 'setFiles', domain: 'a.test', selector: '#f', paths: ['C:\\a'] })).rejects.toThrow(/不支持 setFiles/)
  })

  it('齐了就转给 driver.setFiles(selector, paths)', async () => {
    const setFiles = vi.fn(async () => [{ name: 'a', type: '', size: 1 }])
    const d = { setFiles } as unknown as PageDriver
    const out = await runAction(d, { kind: 'setFiles', domain: 'a.test', selector: '#f', paths: ['C:\\a'] })
    expect(setFiles).toHaveBeenCalledWith('#f', ['C:\\a'])
    expect(out).toEqual([{ name: 'a', type: '', size: 1 }])
  })
})
