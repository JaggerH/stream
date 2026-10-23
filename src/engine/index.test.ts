import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createStream, type Stream } from './index.ts'
import { readConfig } from '../bootstrap.ts'
import { LOCK_NAME } from './data-dir-lock.ts'

/** 一个干净的数据目录 + 一个空的内置包目录（不装仓库里那几十个包，装配只剩宿主自己）。 */
function tempRoot(): { root: string; config: ReturnType<typeof readConfig> } {
  const root = mkdtempSync(join(tmpdir(), 'stream-engine-'))
  const packages = join(root, 'packages')
  mkdirSync(packages)
  const config = { ...readConfig(join(root, 'config.yaml'), { STREAM_DATA_DIR: root }), packages_dir: packages, rsshub_catalog: '' }
  return { root, config }
}

describe('createStream', () => {
  const roots: string[] = []
  const open: Stream[] = []
  afterEach(async () => {
    for (const s of open.splice(0)) await s.close()
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
  })
  const make = async (root: string, config: ReturnType<typeof readConfig>) => {
    const s = await createStream({ dataDir: root, config, log: () => {} })
    open.push(s)
    return s
  }

  it('回一份装好的实例：内核上有域服务，可写状态落在数据目录下', async () => {
    const { root, config } = tempRoot(); roots.push(root)
    const s = await make(root, config)
    expect(s.stateDir).toBe(join(root, 'data'))
    expect(s.kernel.settings).toBeDefined()
    expect(Array.isArray(s.kernel.scheduling.scheduler.list())).toBe(true)
    expect(existsSync(join(root, 'data', 'stream.db'))).toBe(true)
    expect(existsSync(join(root, 'data', LOCK_NAME))).toBe(true)
  })

  it('同一个数据目录第二次 createStream 抛错，第一个实例不受影响', async () => {
    const { root, config } = tempRoot(); roots.push(root)
    const a = await make(root, config)
    await expect(createStream({ dataDir: root, config, log: () => {} })).rejects.toThrow(/已被本进程里的另一个 Stream 实例占用/)
    // A 照常可用：设置照写照读，锁还是 A 的。
    a.kernel.settings.setRuntimeConfig('x', { k: 'v' }, [])
    expect(a.kernel.settings.runtimeConfig('x')).toEqual({ k: 'v' })
    expect(existsSync(join(root, 'data', LOCK_NAME))).toBe(true)
  })

  it('关掉之后同一个目录能再开；close 幂等', async () => {
    const { root, config } = tempRoot(); roots.push(root)
    const a = await createStream({ dataDir: root, config, log: () => {} })
    await a.close()
    await a.close()
    expect(existsSync(join(root, 'data', LOCK_NAME))).toBe(false)
    await make(root, config)
  })

  it('两个数据目录各起一份，互不相干', async () => {
    const one = tempRoot(); const two = tempRoot(); roots.push(one.root, two.root)
    const a = await make(one.root, one.config)
    const b = await make(two.root, two.config)
    a.kernel.settings.setRuntimeConfig('x', { k: 'a' }, [])
    expect(b.kernel.settings.runtimeConfig('x')).toEqual({})
  })

  it('残留的锁（持有进程已经不在了）被接管，不拦启动', async () => {
    const { root, config } = tempRoot(); roots.push(root)
    mkdirSync(join(root, 'data'), { recursive: true })
    // pid 2^22 以上在 Linux 上不会存在（pid_max 上限 4194304）。
    writeFileSync(join(root, 'data', LOCK_NAME), '4194305 1')
    await make(root, config)
  })

  it('没给 config：读数据目录下的 config.yaml，不读环境变量', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stream-engine-')); roots.push(root)
    mkdirSync(join(root, 'packages'))
    writeFileSync(join(root, 'config.yaml'), `packages_dir: ${join(root, 'packages')}\nrsshub_catalog: ''\n`)
    const s = await createStream({ dataDir: root, log: () => {} })
    open.push(s)
    expect(s.stateDir).toBe(join(root, 'data'))
    // 部署开关全按默认、没有环境回落——环境变量只由进程入口翻译。
    expect(s.config.deployment).toMatchObject({ env: {}, scheduler: true, search_text_fold: true })
  })
})
