import { describe, it, expect } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  resolveDockerEndpoint,
  makeDockerClient,
  parseMemBytes,
  managedContainerName,
  decodeDockerLogStream,
  type DockerEndpoint,
  type RawRequest,
} from './engine-api.ts'

describe('createContainer 的 user', () => {
  it('spec.user 原样进 Config.User；不给就不带这个键（沿用镜像自己的 USER）', async () => {
    const bodies: Record<string, unknown>[] = []
    const request: RawRequest = async (_ep, _m, _p, _t, body) => {
      bodies.push(body as Record<string, unknown>)
      return { status: 201, body: JSON.stringify({ Id: 'c' }) }
    }
    const client = makeDockerClient({ socketPath: '/x' }, request)
    const base = { image: 'i', service: 's', port: 1, network: 'n' }
    await client.createContainer({ ...base, user: '0:0' })
    await client.createContainer(base)
    expect(bodies[0]!.User).toBe('0:0')
    expect('User' in bodies[1]!).toBe(false)
  })
})

describe('exec（容器内跑一条命令——managed 档接管 OpenList admin 密码用）', () => {
  it('create → start（attach，读完输出）→ inspect 取 ExitCode', async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = []
    const request: RawRequest = async (_ep, method, path, _t, body) => {
      calls.push({ method, path, body })
      if (path === '/containers/c1/exec') return { status: 201, body: JSON.stringify({ Id: 'e1' }) }
      if (path === '/exec/e1/start') return { status: 200, body: 'admin password set\n' }
      if (path === '/exec/e1/json') return { status: 200, body: JSON.stringify({ ExitCode: 0 }) }
      return { status: 404, body: '' }
    }
    const client = makeDockerClient({ socketPath: '/x' }, request)
    const r = await client.exec('c1', ['./openlist', 'admin', 'set', 'pw'])
    expect(r).toEqual({ exitCode: 0, output: 'admin password set' })
    expect(calls[0]).toEqual({ method: 'POST', path: '/containers/c1/exec', body: { Cmd: ['./openlist', 'admin', 'set', 'pw'], AttachStdout: true, AttachStderr: true } })
    expect(calls[1]).toEqual({ method: 'POST', path: '/exec/e1/start', body: { Detach: false, Tty: false } })
    expect(calls[2]?.path).toBe('/exec/e1/json')
  })

  it('非零退出码原样交回（不抛——调用方决定 admin set 失败算什么）', async () => {
    const request: RawRequest = async (_ep, _m, path) => {
      if (path.endsWith('/exec')) return { status: 201, body: JSON.stringify({ Id: 'e2' }) }
      if (path.endsWith('/start')) return { status: 200, body: 'boom' }
      return { status: 200, body: JSON.stringify({ ExitCode: 2 }) }
    }
    await expect(makeDockerClient({ socketPath: '/x' }, request).exec('c', ['x'])).resolves.toEqual({ exitCode: 2, output: 'boom' })
  })
})

/** 造一帧 docker 日志流:`[stream_type(1) 00 00 00 size(4BE)] payload`。 */
function frame(stream: 1 | 2, payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8')
  const head = Buffer.alloc(8)
  head[0] = stream
  head.writeUInt32BE(body.byteLength, 4)
  return Buffer.concat([head, body])
}

describe('decodeDockerLogStream', () => {
  it('剥掉 8 字节帧头,stdout 与 stderr 合流', () => {
    const raw = Buffer.concat([
      frame(1, '2026-08-07T03:00:00Z started\n'),
      frame(2, '2026-08-07T03:00:01Z bind: address already in use\n'),
    ])
    expect(decodeDockerLogStream(raw)).toEqual([
      '2026-08-07T03:00:00Z started',
      '2026-08-07T03:00:01Z bind: address already in use',
    ])
  })

  // 帧头里的 size 是任意四个字节,按 utf8 解成字符串再切必然错位——所以解帧必须在 Buffer 上做。
  // 用一个 size 落在 0x80–0xFF(非法 utf8 起始字节)的帧钉住这条:字符串路径会把它变成 U+FFFD。
  it('payload 大到 size 字节非 ASCII 时仍然对齐', () => {
    const long = 'x'.repeat(200) // size = 0x000000C8,第四字节 0xC8
    expect(decodeDockerLogStream(frame(1, long + '\n'))).toEqual([long])
  })

  it('多字节字符被切在两帧之间也不乱码', () => {
    const s = Buffer.from('起不来\n', 'utf8')
    const cut = 4 // 落在「不」的中间
    const raw = Buffer.concat([
      Buffer.concat([Buffer.from([1, 0, 0, 0, 0, 0, 0, cut]), s.subarray(0, cut)]),
      Buffer.concat([Buffer.from([1, 0, 0, 0, 0, 0, 0, s.byteLength - cut]), s.subarray(cut)]),
    ])
    expect(decodeDockerLogStream(raw)).toEqual(['起不来'])
  })

  // TTY 容器的日志流**没有帧头**。判据不成立时按裸文本读,别把第一个字节当 size 吃掉。
  it('TTY 容器(无帧头)按裸文本读', () => {
    expect(decodeDockerLogStream(Buffer.from('plain line\nsecond\n', 'utf8'))).toEqual(['plain line', 'second'])
  })

  it('空流 → 空数组,尾部空行不产出空字符串', () => {
    expect(decodeDockerLogStream(Buffer.alloc(0))).toEqual([])
    expect(decodeDockerLogStream(frame(1, 'only\n\n'))).toEqual(['only'])
  })
})

describe('resolveDockerEndpoint', () => {
  it('DOCKER_HOST unix:// wins', () => {
    expect(resolveDockerEndpoint({ DOCKER_HOST: 'unix:///run/user/1000/docker.sock' }, 'linux'))
      .toEqual({ socketPath: '/run/user/1000/docker.sock' })
  })
  it('DOCKER_HOST npipe:// wins', () => {
    expect(resolveDockerEndpoint({ DOCKER_HOST: 'npipe:////./pipe/docker_engine' }, 'win32'))
      .toEqual({ socketPath: '\\\\.\\pipe\\docker_engine' })
  })
  it('DOCKER_HOST tcp:// wins', () => {
    expect(resolveDockerEndpoint({ DOCKER_HOST: 'tcp://10.0.0.5:2375' }, 'linux'))
      .toEqual({ host: '10.0.0.5', port: 2375 })
  })
  it('platform defaults: win32 → npipe, else unix socket', () => {
    expect(resolveDockerEndpoint({}, 'win32')).toEqual({ socketPath: '\\\\.\\pipe\\docker_engine' })
    expect(resolveDockerEndpoint({}, 'linux')).toEqual({ socketPath: '/var/run/docker.sock' })
    expect(resolveDockerEndpoint({}, 'darwin')).toEqual({ socketPath: '/var/run/docker.sock' })
  })
  it('unparseable DOCKER_HOST → null (never throw)', () => {
    expect(resolveDockerEndpoint({ DOCKER_HOST: '???' }, 'linux')).toBeNull()
  })
})

describe('makeDockerClient', () => {
  const calls: string[] = []
  const fake = (status: number, body: string) => async (_ep: DockerEndpoint, method: string, path: string) => {
    calls.push(`${method} ${path}`)
    return { status, body }
  }
  // 专测 timeoutMs:第四参,用来断言各方法各自传了什么超时值(undefined 表示没传、走 defaultRequest 的 5000 默认)。
  const fakeTimeouts = (status: number, body: string) => {
    const timeouts: (number | undefined)[] = []
    const impl = async (_ep: DockerEndpoint, _method: string, _path: string, timeoutMs?: number) => {
      timeouts.push(timeoutMs)
      return { status, body }
    }
    return { impl, timeouts }
  }
  it('logs 拿 raw Buffer 解帧,并把 tail 传给 daemon', async () => {
    const seen: string[] = []
    const impl: RawRequest = async (_ep, _m, path) => {
      seen.push(path)
      return { status: 200, body: '', raw: frame(1, '2026-08-07T03:00:00Z boom\n') }
    }
    const lines = await makeDockerClient({ socketPath: '/s' }, impl).logs('abc', 50)
    expect(lines).toEqual(['2026-08-07T03:00:00Z boom'])
    expect(seen[0]).toContain('/containers/abc/logs?')
    expect(seen[0]).toContain('tail=50')
    // timestamps 必须开:没有它,日志行前面没有任何时间信息,排障时看不出"这是刚才那次还是三天前的"。
    expect(seen[0]).toContain('timestamps=1')
    expect(seen[0]).toContain('stderr=1')
  })

  it('logs 容器不存在 → null(不是错误)', async () => {
    expect(await makeDockerClient({ socketPath: '/s' }, fake(404, 'no such container')).logs('gone', 10)).toBeNull()
  })

  it('logs 其他 HTTP 错误照常抛,由路由翻成 503', async () => {
    await expect(makeDockerClient({ socketPath: '/s' }, fake(500, 'boom')).logs('abc', 10)).rejects.toThrow(/500/)
  })

  it('listByService filters by compose service label', async () => {
    const c = makeDockerClient({ socketPath: '/s' }, fake(200, JSON.stringify([{ Id: 'abc', State: 'running', Names: ['/x'] }])))
    const r = await c.listByService('voiceprint')
    expect(r).toEqual([{ Id: 'abc', State: 'running', Names: ['/x'] }])
    const q = calls.at(-1)!
    expect(q).toContain('GET /containers/json?')
    expect(decodeURIComponent(q)).toContain('com.docker.compose.service=voiceprint')
    expect(q).toContain('all=true')
  })
  it('start/stop accept 204 and 304, reject others', async () => {
    await makeDockerClient({ socketPath: '/s' }, fake(204, '')).start('abc')
    await makeDockerClient({ socketPath: '/s' }, fake(304, '')).stop('abc')
    await expect(makeDockerClient({ socketPath: '/s' }, fake(500, 'boom')).start('abc')).rejects.toThrow(/500/)
  })
  it('ping true on 200, false on transport error', async () => {
    expect(await makeDockerClient({ socketPath: '/s' }, fake(200, 'OK')).ping()).toBe(true)
    const dead = async () => { throw new Error('ENOENT') }
    expect(await makeDockerClient({ socketPath: '/s' }, dead).ping()).toBe(false)
  })
  describe('per-call timeout(冷重容器 docker start 撞 5s 硬超时)', () => {
    it('start 传 60000(冷 GPU 容器实测 40s+ 启动耗时,需要容住)', async () => {
      const { impl, timeouts } = fakeTimeouts(204, '')
      await makeDockerClient({ socketPath: '/s' }, impl).start('abc')
      expect(timeouts.at(-1)).toBe(60_000)
    })
    it('stop 传 15000(比 ?t=10 的等待再留余量)', async () => {
      const { impl, timeouts } = fakeTimeouts(204, '')
      await makeDockerClient({ socketPath: '/s' }, impl).stop('abc')
      expect(timeouts.at(-1)).toBe(15_000)
    })
    it('ping/listByService/inspectHostPort 不传(走 defaultRequest 默认 5000)', async () => {
      const { impl, timeouts } = fakeTimeouts(200, JSON.stringify({ NetworkSettings: { Ports: {} } }))
      const client = makeDockerClient({ socketPath: '/s' }, impl)
      await client.ping()
      await client.inspectHostPort('abc', 9000)
      expect(timeouts).toEqual([undefined, undefined])
    })
  })
  describe('inspectHostPort', () => {
    it('从 NetworkSettings.Ports 读出 loopback 映射口', async () => {
      const client = makeDockerClient({ socketPath: '/x' }, async (_ep, method, path) => {
        expect(method).toBe('GET')
        expect(path).toBe('/containers/abc/json')
        return {
          status: 200,
          body: JSON.stringify({
            NetworkSettings: { Ports: { '9000/tcp': [{ HostIp: '127.0.0.1', HostPort: '44728' }] } },
          }),
        }
      })
      expect(await client.inspectHostPort('abc', 9000)).toBe(44728)
    })
    it('容器停着(Ports 空)→ null', async () => {
      const client = makeDockerClient({ socketPath: '/x' }, async () => ({
        status: 200,
        body: JSON.stringify({ NetworkSettings: { Ports: {} } }),
      }))
      expect(await client.inspectHostPort('abc', 9000)).toBeNull()
    })
    it('非 200 → throw', async () => {
      const client = makeDockerClient({ socketPath: '/x' }, async () => ({ status: 500, body: 'boom' }))
      await expect(client.inspectHostPort('abc', 9000)).rejects.toThrow('docker inspect HTTP 500')
    })
  })
})

// 走真实 defaultRequest(不注入 requestImpl),用一个监听 unix socket 的真 http server 复现
// "响应体读到一半、Docker daemon 断连"——上面 fake() 系的用例永远碰不到这条路径,因为它们绕过了
// node:http 本身。两处关键设计,踩过坑才知道:
// 1) destroy 必须等 client 已经拿到 response 对象(先收完 header)再触发,否则连接在 header 阶段
//    就被打断,Node 会把这当成"请求级"的 socket hang up 交给 req 的 'error'(这条早就有人接了,
//    测不出回归)。
// 2) 必须声明一个比实际写出的 body 更大的 Content-Length,逼 Node 判定这是"意外提前结束"而不是
//    "对端优雅关闭、body 视为读完"——只有前者才会在 res 上产生真正的 error(消息 'aborted')。
// 回归目标:defaultRequest 不接 res 的 'error' 时,这个 error 会在 res 上没有监听器的情况下悬空,
// promise 永不 settle(listByService 挂死直到 vitest 超时判失败),而不是干净地 reject。
describe('parseMemBytes', () => {
  it('解析常见写法', () => {
    expect(parseMemBytes('8G')).toBe(8 * 1024 ** 3)
    expect(parseMemBytes('8g')).toBe(8 * 1024 ** 3)
    expect(parseMemBytes('8GB')).toBe(8 * 1024 ** 3)
    expect(parseMemBytes('512M')).toBe(512 * 1024 ** 2)
    expect(parseMemBytes('1.5G')).toBe(Math.round(1.5 * 1024 ** 3))
    expect(parseMemBytes('1024')).toBe(1024)
    expect(parseMemBytes('  2 g ')).toBe(2 * 1024 ** 3)
  })
  // 0 在 docker 里是"不限制"。解析不了却返回 0 = 一个内存上限被静默抹掉,而且没有任何报错——
  // 必须抛,让配置错误在创建容器之前就响。
  it('解析不了要抛错,绝不静默当 0', () => {
    for (const bad of ['', 'lots', '8 gigs', 'G', '-1G', '0', '8P']) {
      expect(() => parseMemBytes(bad), bad).toThrow(/mem/i)
    }
  })
})

describe('makeDockerClient — 创建类动作', () => {
  /** 捕获每一次调用(含第五参 body),响应由 responder 按 method+path 决定。 */
  const capture = (responder: (method: string, path: string) => { status: number; body: string }) => {
    const seen: { method: string; path: string; timeoutMs?: number; body?: unknown }[] = []
    const impl: RawRequest = async (_ep, method, path, timeoutMs, body) => {
      seen.push({ method, path, timeoutMs, body })
      return responder(method, path)
    }
    return { impl, seen }
  }

  describe('pullImage', () => {
    it('镜像已在本地(GET /images/<image>/json 200)→ 不拉', async () => {
      const { impl, seen } = capture(() => ({ status: 200, body: '{}' }))
      await makeDockerClient({ socketPath: '/s' }, impl).pullImage('alist/alist:latest')
      expect(seen).toHaveLength(1)
      expect(seen[0].method).toBe('GET')
      expect(seen[0].path).toContain('/images/')
      expect(decodeURIComponent(seen[0].path)).toContain('alist/alist:latest')
    })
    it('不在本地 → POST /images/create?fromImage=…,超时给 600s', async () => {
      const { impl, seen } = capture((method) =>
        method === 'GET'
          ? { status: 404, body: '{"message":"no such image"}' }
          : { status: 200, body: '{"status":"Pulling"}\n{"status":"Download complete"}\n' },
      )
      await makeDockerClient({ socketPath: '/s' }, impl).pullImage('alist/alist:latest')
      expect(seen).toHaveLength(2)
      expect(seen[1].method).toBe('POST')
      expect(seen[1].path).toContain('/images/create?fromImage=')
      expect(decodeURIComponent(seen[1].path)).toContain('alist/alist:latest')
      // 几百 MB 的镜像,5s 默认超时必然半路砍断
      expect(seen[1].timeoutMs).toBe(600_000)
    })
    it('拉取 HTTP 非 2xx → 抛错且带镜像名', async () => {
      const { impl } = capture((method) =>
        method === 'GET' ? { status: 404, body: '' } : { status: 500, body: 'boom' },
      )
      await expect(makeDockerClient({ socketPath: '/s' }, impl).pullImage('ghcr.io/x/y:1'))
        .rejects.toThrow(/ghcr\.io\/x\/y:1/)
    })
    it('流里带 errorDetail(HTTP 仍是 200)→ 抛错且带镜像名', async () => {
      const { impl } = capture((method) =>
        method === 'GET'
          ? { status: 404, body: '' }
          : { status: 200, body: '{"status":"Pulling"}\n{"errorDetail":{"message":"manifest unknown"},"error":"manifest unknown"}\n' },
      )
      await expect(makeDockerClient({ socketPath: '/s' }, impl).pullImage('ghcr.io/x/y:1'))
        .rejects.toThrow(/ghcr\.io\/x\/y:1/)
    })
  })

  describe('createContainer', () => {
    const spec = {
      image: 'alist/alist:latest',
      service: 'alist',
      port: 5244,
      env: { TZ: 'Asia/Shanghai', NOTE: '中文说明' },
      volumes: ['alist_data:/opt/alist/data'],
      mem: '8G',
      network: 'stream',
    }
    const created = { status: 201, body: JSON.stringify({ Id: 'newid', Warnings: [] }) }

    it('body 带齐 Image/Env/ExposedPorts/HostConfig/Labels', async () => {
      const { impl, seen } = capture(() => created)
      const id = await makeDockerClient({ socketPath: '/s' }, impl).createContainer(spec)
      expect(id).toBe('newid')
      expect(seen).toHaveLength(1)
      expect(seen[0].method).toBe('POST')
      expect(seen[0].path).toContain('/containers/create?name=')
      expect(decodeURIComponent(seen[0].path)).toContain(managedContainerName('alist'))
      const body = seen[0].body as Record<string, any>
      expect(body.Image).toBe('alist/alist:latest')
      expect(body.Env).toEqual(['TZ=Asia/Shanghai', 'NOTE=中文说明'])
      expect(body.ExposedPorts).toEqual({ '5244/tcp': {} })
      expect(body.HostConfig.NetworkMode).toBe('stream')
      expect(body.HostConfig.Binds).toEqual(['alist_data:/opt/alist/data'])
      expect(body.HostConfig.Memory).toBe(8 * 1024 ** 3)
      // standby 就是按这个 label 找容器的;缺了它 = 容器起着但唤醒永远失败
      expect(body.Labels['com.docker.compose.service']).toBe('alist')
      expect(body.Labels['app.stream.managed']).toBe('1')
    })
    it('publishLoopback → PortBindings 绑 127.0.0.1 随机口;不给就没有 PortBindings', async () => {
      const a = capture(() => created)
      await makeDockerClient({ socketPath: '/s' }, a.impl).createContainer({ ...spec, publishLoopback: true })
      expect((a.seen[0].body as any).HostConfig.PortBindings).toEqual({
        '5244/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }],
      })
      const b = capture(() => created)
      await makeDockerClient({ socketPath: '/s' }, b.impl).createContainer(spec)
      expect((b.seen[0].body as any).HostConfig.PortBindings).toBeUndefined()
    })
    it('gpu → DeviceRequests', async () => {
      const { impl, seen } = capture(() => created)
      await makeDockerClient({ socketPath: '/s' }, impl).createContainer({ ...spec, gpu: true })
      expect((seen[0].body as any).HostConfig.DeviceRequests).toEqual([
        { Driver: 'nvidia', Count: 1, Capabilities: [['gpu']] },
      ])
    })
    it('宿主路径 bind → 抛错(P5a 只接受命名卷),且一个请求都不发', async () => {
      const { impl, seen } = capture(() => created)
      const c = makeDockerClient({ socketPath: '/s' }, impl)
      await expect(c.createContainer({ ...spec, volumes: ['/srv/data:/opt/alist/data'] })).rejects.toThrow(/命名卷|named volume/)
      await expect(c.createContainer({ ...spec, volumes: ['./data:/opt/alist/data'] })).rejects.toThrow()
      await expect(c.createContainer({ ...spec, volumes: ['C:\\data:/opt/alist/data'] })).rejects.toThrow()
      expect(seen).toHaveLength(0)
    })
    it('mem 解析不了 → 抛错,不发请求', async () => {
      const { impl, seen } = capture(() => created)
      await expect(makeDockerClient({ socketPath: '/s' }, impl).createContainer({ ...spec, mem: '8 gigs' }))
        .rejects.toThrow(/mem/i)
      expect(seen).toHaveLength(0)
    })
    it('非 201 → 抛错', async () => {
      const { impl } = capture(() => ({ status: 409, body: 'name conflict' }))
      await expect(makeDockerClient({ socketPath: '/s' }, impl).createContainer(spec))
        .rejects.toThrow(/docker create HTTP 409/)
    })
  })

  describe('removeContainer', () => {
    it('204 成功,404(已不存在)也算成功', async () => {
      const a = capture(() => ({ status: 204, body: '' }))
      await makeDockerClient({ socketPath: '/s' }, a.impl).removeContainer('abc')
      expect(a.seen[0].method).toBe('DELETE')
      expect(a.seen[0].path).toContain('/containers/abc')
      expect(a.seen[0].path).toContain('force=true')
      const b = capture(() => ({ status: 404, body: '{"message":"No such container"}' }))
      await expect(makeDockerClient({ socketPath: '/s' }, b.impl).removeContainer('abc')).resolves.toBeUndefined()
    })
    it('其余状态码 → 抛错', async () => {
      const { impl } = capture(() => ({ status: 500, body: 'boom' }))
      await expect(makeDockerClient({ socketPath: '/s' }, impl).removeContainer('abc')).rejects.toThrow(/500/)
    })
  })

  describe('ensureNetwork', () => {
    it('201 创建成功;409(已存在)也算成功', async () => {
      const a = capture(() => ({ status: 201, body: '{"Id":"n1"}' }))
      await makeDockerClient({ socketPath: '/s' }, a.impl).ensureNetwork('stream')
      expect(a.seen[0].method).toBe('POST')
      expect(a.seen[0].path).toBe('/networks/create')
      expect((a.seen[0].body as any).Name).toBe('stream')
      const b = capture(() => ({ status: 409, body: '{"message":"already exists"}' }))
      await expect(makeDockerClient({ socketPath: '/s' }, b.impl).ensureNetwork('stream')).resolves.toBeUndefined()
    })
    it('其余状态码 → 抛错', async () => {
      const { impl } = capture(() => ({ status: 500, body: 'boom' }))
      await expect(makeDockerClient({ socketPath: '/s' }, impl).ensureNetwork('stream')).rejects.toThrow(/500/)
    })
  })

  describe('inspectState', () => {
    it('running / exited / 不存在', async () => {
      const run = capture(() => ({
        status: 200,
        body: JSON.stringify({ State: { Running: true }, Config: { Image: 'alist/alist:latest' } }),
      }))
      expect(await makeDockerClient({ socketPath: '/s' }, run.impl).inspectState('abc'))
        .toEqual({ running: true, image: 'alist/alist:latest' })
      const exited = capture(() => ({
        status: 200,
        body: JSON.stringify({ State: { Running: false }, Config: { Image: 'alist/alist:1' } }),
      }))
      expect(await makeDockerClient({ socketPath: '/s' }, exited.impl).inspectState('abc'))
        .toEqual({ running: false, image: 'alist/alist:1' })
      const gone = capture(() => ({ status: 404, body: '{"message":"No such container"}' }))
      expect(await makeDockerClient({ socketPath: '/s' }, gone.impl).inspectState('abc')).toBeNull()
    })
    it('其余状态码 → 抛错', async () => {
      const { impl } = capture(() => ({ status: 500, body: 'boom' }))
      await expect(makeDockerClient({ socketPath: '/s' }, impl).inspectState('abc')).rejects.toThrow(/500/)
    })
  })
})

// 走真实 defaultRequest:body 发送与流式读取这两条,只有真 socket 才验得到。
describe('defaultRequest (real socket) — 请求体与流式响应', () => {
  const withServer = async (
    handler: http.RequestListener,
    run: (ep: DockerEndpoint) => Promise<void>,
  ) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-api-test-'))
    const socketPath = path.join(dir, 'docker.sock')
    const server = http.createServer(handler)
    try {
      await new Promise<void>((resolve) => server.listen(socketPath, resolve))
      await run({ socketPath })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  // Content-Length 按字符串长度算,非 ASCII 的 env 值就会少报字节数,daemon 一直等剩下的字节、
  // 直到请求超时——没有报错、只是挂住,极难查。这条用一个含中文的 env 值把它钉死。
  it('POST body 的 Content-Length 按 Buffer 字节数算(非 ASCII 不能算错)', async () => {
    let received = ''
    let declared = ''
    await withServer(
      (req, res) => {
        declared = String(req.headers['content-length'] ?? '')
        expect(req.headers['content-type']).toBe('application/json')
        req.on('data', (c) => (received += c))
        req.on('end', () => {
          res.writeHead(201, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ Id: 'newid' }))
        })
      },
      async (ep) => {
        const id = await makeDockerClient(ep).createContainer({
          image: 'x/y:1',
          service: 'alist',
          port: 5244,
          env: { NOTE: '中文说明中文说明' },
          network: 'stream',
        })
        expect(id).toBe('newid')
      },
    )
    expect(received).toContain('中文说明中文说明')
    expect(Number(declared)).toBe(Buffer.byteLength(received, 'utf8'))
    expect(Number(declared)).toBeGreaterThan(received.length) // 中文 → 字节数 > 字符数
  })

  // pull 的响应是一串 JSON 行,边拉边写。只看 HTTP 状态就返回,会在镜像还没拉完时说"拉好了",
  // 随后 create 报"镜像不存在"。这条断言:必须读到流结束才 resolve。
  it('pullImage 读到流结束才返回', async () => {
    let streamEnded = false
    let resolvedBeforeEnd = true
    await withServer(
      (req, res) => {
        if (req.method === 'GET') {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end('{"message":"no such image"}')
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.write('{"status":"Pulling from x/y"}\n')
        setTimeout(() => {
          res.write('{"status":"Download complete"}\n')
          setTimeout(() => {
            streamEnded = true
            res.end('{"status":"Status: Downloaded newer image for x/y:1"}\n')
          }, 30)
        }, 30)
      },
      async (ep) => {
        await makeDockerClient(ep).pullImage('x/y:1')
        resolvedBeforeEnd = !streamEnded
      },
    )
    expect(resolvedBeforeEnd).toBe(false)
  })
})

describe('defaultRequest (real socket, mid-body disconnect)', () => {
  it('rejects instead of hanging/crashing when the response errors mid-body', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-api-test-'))
    const socketPath = path.join(dir, 'docker.sock')
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' })
      res.write('{"partial":')
      // 延迟到下一个 tick 之后,确保 client 已经把 header 解析完、response 事件已经触发,
      // 这样断连命中的是 res 的错误路径而不是 req 的。
      setTimeout(() => res.socket?.destroy(new Error('simulated docker daemon disconnect')), 20)
    })
    try {
      await new Promise<void>((resolve) => server.listen(socketPath, resolve))
      const client = makeDockerClient({ socketPath })
      await expect(client.listByService('voiceprint')).rejects.toThrow()
      // 进程活到这里、还能再发一次请求,证明上一次失败是一次干净的 reject,不是把 event loop
      // 带崩或者留下悬空监听器。
      await expect(client.ping()).resolves.toBe(false)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
