import { describe, it, expect, vi } from 'vitest'
import { compileUserTask, compileEnabled } from './user-tasks.ts'
import type { UserTaskRow } from './task-store.ts'
import type { PackageAction } from './package-actions.ts'
import { currentDeviceId } from '../devices/run-context.ts'
import { pickBrowser } from '../devices/placement.ts'
import { DeviceIncapable, DeviceLost, DeviceOffline, IdentityMismatch, failureDisposition } from '../devices/errors.ts'
import { makeFetchFor } from '../devices/fetch.ts'

const row: UserTaskRow = {
  id: 'dl-freshness', label: '数据新鲜度巡检', schedule: '0 0 * * * *',
  timezone: 'Asia/Shanghai',
  command: '/bin/python', args: ['-m', 'data_pipeline.monitors.data_sources'],
  cwd: '/work', env: { PYTHONPATH: '.' }, timeoutMs: 60_000,
  serial: true, maxAttempts: 1, enabled: true,
  createdAt: 1, updatedAt: 1,
}

describe('compileUserTask', () => {
  it('行里的排期/并发/重试原样落到 ScheduledTask 上', () => {
    const t = compileUserTask(row)
    expect(t.id).toBe('dl-freshness')
    expect(t.label).toBe('数据新鲜度巡检')
    expect(t.schedule).toBe('0 0 * * * *')
    expect(t.timezone).toBe('Asia/Shanghai')
    expect(t.serial).toBe(true)
    expect(t.maxAttempts).toBe(1)
  })

  // 这两格决定这条任务进哪个队列、轮不上时跑不跑。透传漏了的表现是**一条设了互斥的任务
  // 安静地跟别人并发**——不报错，界面上也看不出来，只有账本里的时间戳会重叠。
  it('互斥组和迟到语义透传到 ScheduledTask；没填就不带这两格', () => {
    const t = compileUserTask({ ...row, exclusiveOn: 'jq-bridge', whenBusy: 'skip' })
    expect(t.exclusiveOn).toBe('jq-bridge')
    expect(t.whenBusy).toBe('skip')
    const bare = compileUserTask(row)
    expect('exclusiveOn' in bare).toBe(false)
    expect('whenBusy' in bare).toBe(false)
  })

  it('run 把命令原样交给执行器，并按 id 给出日志路径', async () => {
    const exec = vi.fn().mockResolvedValue({ summary: 'ok' })
    const t = compileUserTask(row, { logDir: '/logs', exec })
    const out = await t.run({ log: () => {} })
    expect(out).toEqual({ summary: 'ok' })
    expect(exec).toHaveBeenCalledWith({
      command: '/bin/python',
      args: ['-m', 'data_pipeline.monitors.data_sources'],
      cwd: '/work',
      env: { PYTHONPATH: '.' },
      timeoutMs: 60_000,
      logFile: '/logs/dl-freshness.log',
    })
  })

  it('compileEnabled 跳过 enabled=false 的行', () => {
    const ids = compileEnabled([row, { ...row, id: 'off', enabled: false }]).map((t) => t.id)
    expect(ids).toEqual(['dl-freshness'])
  })

  it('可选字段缺省时整个键都不出现——传 undefined 过去 toHaveBeenCalledWith 是看不出来的', async () => {
    const rowMinimal: UserTaskRow = {
      id: 'minimal-task',
      label: '最小化任务',
      schedule: '0 0 * * * *',
      command: '/bin/true',
      args: [],
      serial: false,
      maxAttempts: 1,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
      // timezone, cwd, env, timeoutMs all absent
    }

    const exec = vi.fn().mockResolvedValue({ summary: 'ok' })
    const t = compileUserTask(rowMinimal, { exec })

    // Verify ScheduledTask structure has no optional keys
    // notBefore 恒在（取 createdAt）——它是丢班自愈的下界，缺了新建任务会被当场倒补一次
    expect(Object.keys(t).sort()).toEqual(['id', 'label', 'maxAttempts', 'notBefore', 'run', 'schedule', 'serial'])
    expect(t.notBefore).toBe(rowMinimal.createdAt)

    // Verify exec call has no optional keys
    await t.run({ log: () => {} })
    const arg = exec.mock.calls[0][0]
    expect(Object.keys(arg).sort()).toEqual(['args', 'command'])
  })
})

/**
 * 执行体之二：一条用户任务指向包提供的动作。东方财富那三条走的就是这条路——它们不是特例，
 * 排期、启停、账号全在任务行和它绑的配置 row 里。
 */
describe('compileUserTask —— 动作型的行', () => {
  const actionRow: UserTaskRow = {
    id: 'em-repo', label: '东财 撤单+逆回购', schedule: '0 55 14 * * 1-5',
    action: 'eastmoney:repo', args: [], serial: true, maxAttempts: 1,
    configRef: 'eastmoney', enabled: true, createdAt: 1, updatedAt: 1,
  }

  it('调那个动作，参数来自它绑的配置 row', async () => {
    const run = vi.fn<PackageAction>(async () => ({ summary: 'ok' }))
    const t = compileUserTask(actionRow, {
      actions: (n) => (n === 'eastmoney:repo' ? run : undefined),
      paramsFor: (ref) => (ref === 'eastmoney' ? { zjzh: '123', trading: true } : {}),
    })
    expect(await t.run({ log: () => {} })).toEqual({ summary: 'ok' })
    expect(run).toHaveBeenCalledWith({ zjzh: '123', trading: true })
  })

  // 存快照的表现是"改了没反应"，而且不报错——用户在界面上把「真下单」勾上，下一轮还是空跑。
  it('参数每次跑现取，不在编译期冻住', async () => {
    const run = vi.fn<PackageAction>(async () => ({ summary: 'ok' }))
    let trading = false
    const t = compileUserTask(actionRow, {
      actions: () => run,
      paramsFor: () => ({ trading }),
    })
    await t.run({ log: () => {} })
    trading = true
    await t.run({ log: () => {} })
    expect(run.mock.calls.map((c) => c[0])).toEqual([{ trading: false }, { trading: true }])
  })

  // 一条任务安安静静什么都不做，和"它跑了、没事可做"长得一模一样。包被关掉、装载失败、
  // 名字打错——三种都该在这条任务的历次执行里红一次。
  it('动作不在名录里 ⇒ 抛，不是静默跳过', async () => {
    const t = compileUserTask(actionRow, { actions: () => undefined })
    await expect(t.run({ log: () => {} })).rejects.toThrow(/没有这个动作：eastmoney:repo/)
  })

  it('没绑配置格 ⇒ 空参数袋（缺什么由动作自己说，它比调度器清楚）', async () => {
    const run = vi.fn<PackageAction>(async () => ({ summary: 'ok' }))
    const { configRef: _drop, ...noRef } = actionRow
    const t = compileUserTask(noRef, { actions: () => run, paramsFor: () => ({ zjzh: '不该拿到' }) })
    await t.run({ log: () => {} })
    expect(run).toHaveBeenCalledWith({})
  })

  it('动作型的行不碰 exec', async () => {
    const exec = vi.fn()
    const t = compileUserTask(actionRow, { exec, actions: () => async () => ({ summary: 'ok' }) })
    await t.run({ log: () => {} })
    expect(exec).not.toHaveBeenCalled()
  })
})

describe('action tasks run on their placement', () => {
  const emRow: UserTaskRow = {
    id: 'em', label: 'x', schedule: '0 45 9 * * *', action: 'eastmoney:calendar', args: [],
    serial: true, maxAttempts: 1, enabled: true, createdAt: 0, updatedAt: 0,
  }

  it('动作在解析出的设备上下文里跑，结果带设备', async () => {
    let seen = ''
    const t = compileUserTask(emRow, {
      actions: () => async () => { seen = currentDeviceId(); return { summary: 'ok', detail: { n: 1 } } },
      placement: () => ({ deviceId: 'linux:nas', allowHosts: ['eastmoneysec.com'] }),
      ready: () => {},
    })
    const out = await t.run({} as never)
    expect(seen).toBe('linux:nas')
    expect(out).toEqual({ summary: 'ok', detail: { device: 'linux:nas', detail: { n: 1 } } })
  })

  it('用过浏览器：结果带这次选定的绑定；没用过就没有这一格', async () => {
    const used = compileUserTask(emRow, {
      actions: () => async () => {
        pickBrowser({ pick: () => 'ext:a' })
        return { summary: 'ok' }
      },
      placement: () => ({ deviceId: 'linux:nas', allowHosts: [] }),
      ready: () => {},
    })
    expect(await used.run({} as never)).toEqual({ summary: 'ok', detail: { device: 'linux:nas', browser: 'ext:a', detail: undefined } })
    const plain = compileUserTask(emRow, {
      actions: () => async () => ({ summary: 'ok' }),
      placement: () => ({ deviceId: 'linux:nas', allowHosts: [] }),
      ready: () => {},
    })
    expect(await plain.run({} as never)).toEqual({ summary: 'ok', detail: { device: 'linux:nas', detail: undefined } })
  })

  it('用过浏览器且落在一个节点上：结果带节点、profile 名与环境（browser-identity D12）', async () => {
    const nodeOf = (b: string) => (b === 'ext:a' ? { nodeId: 'node_a', profileName: '工作', environment: '工作' } : b === 'local:node_w' ? { nodeId: 'node_w' } : undefined)
    const remote = compileUserTask(emRow, {
      actions: () => async () => { pickBrowser({ pick: () => 'ext:a' }); return { summary: 'ok' } },
      placement: () => ({ deviceId: 'linux:nas', allowHosts: [] }),
      ready: () => {},
      nodeOf,
    })
    expect(await remote.run({} as never)).toEqual({
      summary: 'ok',
      detail: { device: 'linux:nas', browser: 'ext:a', node: 'node_a', profileName: '工作', environment: '工作', detail: undefined },
    })
    const local = compileUserTask(emRow, {
      actions: () => async () => { pickBrowser({ pick: () => 'local:node_w', isOnline: () => true }); return { summary: 'ok', detail: { n: 1 } } },
      placement: () => ({ deviceId: 'local', allowHosts: [] }),
      ready: () => {},
      nodeOf,
    })
    expect(await local.run({} as never)).toEqual({ summary: 'ok', detail: { device: 'local', browser: 'local:node_w', node: 'node_w', detail: { n: 1 } } })
  })

  it('按身份执行：沿用解析时预填的节点（不重选）、带上账号；收尾在动作之后（browser-identity D7、D12）', async () => {
    const order: string[] = []
    const nodeOf = (b: string) => (b === 'local:node_w' ? { nodeId: 'node_w', profileName: '工作' } : undefined)
    const t = compileUserTask(emRow, {
      actions: () => async () => {
        // pick 若被叫到就会选到别的节点——预填过的记号不该再问它
        order.push(`act:${pickBrowser({ pick: () => 'local:node_other', isOnline: () => true })}`)
        return { summary: 'ok' }
      },
      placement: async () => ({
        deviceId: 'local', allowHosts: [], facility: 'eastmoney',
        browser: { bindingId: 'local:node_w' },
        identity: { facility: 'eastmoney', accountId: 'acc1', accountName: '12****78', nodeId: 'node_w' },
        release: async () => void order.push('release'),
      }),
      ready: () => {},
      nodeOf,
    })
    expect(await t.run({} as never)).toEqual({
      summary: 'ok',
      detail: { device: 'local', browser: 'local:node_w', node: 'node_w', profileName: '工作', accountId: 'acc1', accountName: '12****78', detail: undefined },
    })
    expect(order).toEqual(['act:local:node_w', 'release'])
  })

  it('按身份执行在远程设备上：记录同样带账号', async () => {
    const t = compileUserTask(emRow, {
      actions: () => async () => ({ summary: 'ok' }),
      placement: async () => ({
        deviceId: 'linux:lap', allowHosts: [], browser: { bindingId: 'ext:lap' },
        identity: { facility: 'eastmoney', accountId: 'acc1', nodeId: 'node_lap' },
      }),
      ready: () => {},
      nodeOf: () => ({ nodeId: 'node_lap' }),
    })
    expect((await t.run({} as never) as { detail: unknown }).detail).toEqual({ device: 'linux:lap', browser: 'ext:lap', node: 'node_lap', accountId: 'acc1', detail: undefined })
  })

  it('解析目标时就失败（identity-*）：动作一次都不调', async () => {
    const fn = vi.fn()
    const t = compileUserTask(emRow, {
      actions: () => fn,
      placement: async () => { throw new IdentityMismatch('eastmoney', '身份 eastmoney:acc1', 'node_w', '别的号', '「工作」') },
    })
    await expect(t.run({} as never)).rejects.toBeInstanceOf(IdentityMismatch)
    expect(fn).not.toHaveBeenCalled()
  })

  it('本机落在兼容槽（老扩展）上：结果原样', async () => {
    const t = compileUserTask(emRow, {
      actions: () => async () => { pickBrowser({ pick: () => 'local', isOnline: () => true }); return { summary: 'ok', detail: { n: 1 } } },
      placement: () => ({ deviceId: 'local', allowHosts: [] }),
      ready: () => {},
      nodeOf: () => undefined,
    })
    expect(await t.run({} as never)).toEqual({ summary: 'ok', detail: { n: 1 } })
  })

  it('local 时结果原样', async () => {
    const t = compileUserTask(emRow, {
      actions: () => async () => ({ summary: 'ok', detail: { n: 1 } }),
      placement: () => ({ deviceId: 'local', allowHosts: [] }),
      ready: () => {},
    })
    expect(await t.run({} as never)).toEqual({ summary: 'ok', detail: { n: 1 } })
  })

  it('设备不就绪：动作一次都不调', async () => {
    const fn = vi.fn()
    const t = compileUserTask(emRow, {
      actions: () => fn,
      placement: () => ({ deviceId: 'linux:nas', allowHosts: [] }),
      ready: () => { throw new DeviceOffline('linux:nas') },
    })
    await expect(t.run({} as never)).rejects.toBeInstanceOf(DeviceOffline)
    expect(fn).not.toHaveBeenCalled()
  })

  it('中止原因是 DOMException（message 只读）：照样点名设备，原错误留在 cause，仍可重试', async () => {
    const reason = new DOMException('This operation was aborted', 'AbortError')
    const t = compileUserTask(emRow, {
      actions: () => async () => { throw reason },
      placement: () => ({ deviceId: 'linux:nas', allowHosts: [] }),
      ready: () => {},
    })
    const e = await t.run({} as never).catch((x: unknown) => x) as Error
    expect(e).not.toBeInstanceOf(TypeError)
    expect(e.message).toBe('[设备 linux:nas] This operation was aborted')
    expect(e.cause).toBe(reason)
    expect(failureDisposition(e)).toBe('retry')
  })

  describe('发出过请求之后的失败一律不重试（dispatch 标记）', () => {
    const NAS = { deviceId: 'linux:nas', allowHosts: ['eastmoneysec.com'] }
    const URL_ = 'https://jywg.eastmoneysec.com/Trade/SubmitTrade'
    /** 一台第一笔之后就掉线的设备。 */
    function flakyDevice() {
      let online = true
      const sent: string[] = []
      const relay = {
        connected: true,
        fetchOp: async (a: { url: string }, o?: { onSent?: () => void }) => {
          o?.onSent?.(); sent.push(a.url); online = false
          return { status: 200, headers: [], body: '', url: a.url }
        },
      }
      const f = makeFetchFor({
        local: vi.fn(async () => new Response('local')),
        directory: { isOnline: () => online, hasOp: () => true, fetchRelay: () => (online ? relay : undefined) },
      })
      return { f, sent }
    }

    it('submit #1 已发出、设备掉线、submit #2 → 任务 final，不重试', async () => {
      const { f, sent } = flakyDevice()
      const t = compileUserTask(emRow, {
        actions: () => async () => {
          // 像 eastmoney 的 submitOne 那样把错误吞成普通 Error（连 cause 都没留）
          await f(URL_, { method: 'POST', body: 'a=1' })
          try { await f(URL_, { method: 'POST', body: 'a=2' }) } catch (e) { throw new Error(`申购失败：${(e as Error).message}`) }
          return { summary: 'ok' }
        },
        placement: () => NAS,
        ready: () => {},
      })
      const e = await t.run({} as never).catch((x) => x)
      expect(sent).toHaveLength(1)
      expect(failureDisposition(e)).toBe('final')
      expect(e).toBeInstanceOf(DeviceLost)
    })

    it('发出之后的 DeviceOffline（可重试类）也被收成 final', async () => {
      const { f } = flakyDevice()
      const t = compileUserTask(emRow, {
        actions: () => async () => { await f(URL_, { method: 'POST' }); await f(URL_, { method: 'POST' }); return { summary: 'ok' } },
        placement: () => NAS,
        ready: () => {},
      })
      const e = await t.run({} as never).catch((x) => x)
      expect(failureDisposition(e)).toBe('final')
      expect(e).toBeInstanceOf(DeviceLost)
      expect((e as DeviceLost).cause).toBeInstanceOf(DeviceOffline)
    })

    it('发出之后的不可重试设备错误原样（不再包一层）', async () => {
      const { f } = flakyDevice()
      const incapable = new DeviceIncapable('linux:nas', 'browser')
      const t = compileUserTask(emRow, {
        actions: () => async () => { await f(URL_, { method: 'POST' }); throw incapable },
        placement: () => NAS,
        ready: () => {},
      })
      await expect(t.run({} as never)).rejects.toBe(incapable)
    })

    it('ready() 的 DeviceOffline（什么都没发）→ 可重试', async () => {
      const t = compileUserTask(emRow, {
        actions: () => vi.fn(),
        placement: () => NAS,
        ready: () => { throw new DeviceOffline('linux:nas') },
      })
      const e = await t.run({} as never).catch((x) => x)
      expect(e).toBeInstanceOf(DeviceOffline)
      expect(failureDisposition(e)).toBe('retry')
    })

    it('失败点名设备：前缀 [设备 id]，同一个实例；发出后的失败写明状态未知、保留原因', async () => {
      const boom = new Error('读配置失败')
      const t1 = compileUserTask(emRow, { actions: () => async () => { throw boom }, placement: () => NAS, ready: () => {} })
      const e1 = await t1.run({} as never).catch((x) => x)
      expect(e1).toBe(boom)
      expect(e1.message).toBe('[设备 linux:nas] 读配置失败')

      const offline = new DeviceOffline('linux:nas')
      const t2 = compileUserTask(emRow, { actions: () => vi.fn(), placement: () => NAS, ready: () => { throw offline } })
      const e2 = await t2.run({} as never).catch((x) => x)
      expect(e2).toBe(offline)
      expect(e2.message.startsWith('[设备 linux:nas] ')).toBe(true)

      const { f } = flakyDevice()
      const t3 = compileUserTask(emRow, {
        actions: () => async () => { await f(URL_, { method: 'POST' }); throw new Error('券商回了 500') },
        placement: () => NAS, ready: () => {},
      })
      const e3 = await t3.run({} as never).catch((x) => x)
      expect(e3.message.startsWith('[设备 linux:nas] ')).toBe(true)
      expect(e3.message).toContain('状态未知，需要人工核对')
      expect(e3.message).toContain('券商回了 500')

      const refused = new DeviceIncapable('linux:nas', 'browser')
      const { f: f4 } = flakyDevice()
      const t4b = compileUserTask(emRow, {
        actions: () => async () => { await f4(URL_, { method: 'POST' }); throw refused },
        placement: () => NAS, ready: () => {},
      })
      const e4 = await t4b.run({} as never).catch((x) => x)
      expect(e4).toBe(refused)
      expect(e4.message).toContain('状态未知，需要人工核对')
    })

    it('local 的失败不加前缀', async () => {
      const boom = new Error('x')
      const t = compileUserTask(emRow, { actions: () => async () => { throw boom }, placement: () => ({ deviceId: 'local', allowHosts: [] }) })
      await expect(t.run({} as never)).rejects.toThrow(/^x$/)
    })

    it('什么都没发出就失败的普通错误照旧可重试', async () => {
      const t = compileUserTask(emRow, {
        actions: () => async () => { throw new Error('读配置失败') },
        placement: () => NAS,
        ready: () => {},
      })
      const e = await t.run({} as never).catch((x) => x)
      expect(failureDisposition(e)).toBe('retry')
    })
  })
})
