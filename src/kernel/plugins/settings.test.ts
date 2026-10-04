import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel, quiesceKernel } from '../context.ts'
import { settingsPlugin } from './settings.ts'
import { SettingsStore } from '../../settings-store.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'stream-settings-'))

describe('settingsPlugin', () => {
  it('挂成 ctx.settings，dispose 后消失', async () => {
    const kernel = createKernel()
    await kernel.plugin(settingsPlugin, { path: join(tmp(), 'settings.json') })
    expect(kernel.settings).toBeInstanceOf(SettingsStore)
    // 本域注册的配置 row（spec config-rows-slice1）：video-sources 归 settings 域自己。
    expect(kernel.settings.rows.has('video-sources')).toBe(true)
    await quiesceKernel(kernel)
    expect(kernel.settings).toBeUndefined()
  })

  it('读写落在传进来的那份文件上（两棵树各读各的，不共享全局单例）', async () => {
    const a = createKernel()
    const b = createKernel()
    await a.plugin(settingsPlugin, { path: join(tmp(), 'settings.json') })
    await b.plugin(settingsPlugin, { path: join(tmp(), 'settings.json') })
    a.settings.setRowValues('alist', { url: '甲' })
    expect(a.settings.rowValues('alist')?.url).toBe('甲')
    expect(b.settings.rowValues('alist')?.url).toBeUndefined()
    await quiesceKernel(a)
    await quiesceKernel(b)
  })
})
