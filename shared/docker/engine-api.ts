import http from 'node:http'

/** Docker Engine API 入口。socketPath = unix socket 或 Windows named pipe(node:http 原生支持);
 *  host/port = tcp。见 spec「两种部署形态」。 */
export interface DockerEndpoint { socketPath?: string; host?: string; port?: number }
export interface DockerContainer { Id: string; State: string; Names: string[] }
/** 第四参 timeoutMs 可选,不传交给 defaultRequest 的默认值(5000)。见「per-call timeout」注释。
 *  第五参 body 可选:给了就以 JSON 发出(Content-Type: application/json)。加它不影响既有调用方。
 *
 *  返回值里的 `raw` 是**未经 utf8 解码的原始字节**,只有 `logs` 用得上:容器日志流带 8 字节
 *  二进制帧头,`body` 那一步的 utf8 解码会把它揉成 U+FFFD、字节从此对不齐(见
 *  `decodeDockerLogStream`)。其余端点全是 JSON,照旧读 `body`。注入 fake 的测试不给 `raw`,
 *  `logs` 会回落成"按裸文本读"——那正是 TTY 容器的样子,不是 fallback 幻觉。 */
export type RawRequest = (
  ep: DockerEndpoint,
  method: string,
  path: string,
  timeoutMs?: number,
  body?: unknown,
) => Promise<{ status: number; body: string; raw?: Buffer }>

/** 运行时创建一个后端容器需要的全部东西(发行版用户没有仓库、没有 compose CLI,由后端自己建)。 */
export interface ContainerSpec {
  image: string
  /** compose service 名。既作 standby 的查找键(label),也作容器名的一部分。 */
  service: string
  /** 容器内端口 */
  port: number
  env?: Record<string, string>
  /** 只许命名卷(`name:/path`)——宿主路径 bind 在 P5a 里不接受,内置包今天也没有用到。 */
  volumes?: string[]
  mem?: string
  gpu?: boolean
  /** 发布到 127.0.0.1 的随机宿主口(host 档那条路) */
  publishLoopback?: boolean
  network: string
  /** 容器内跑成谁(`Config.User`,如 `'0:0'`)。不给 = 沿用镜像自己的 USER。Engine API 新建的命名卷是 root
   *  属主,镜像以非 root 跑又不自己 chown 时,这是唯一不需要第二个容器的解法。 */
  user?: string
}

export interface DockerClient {
  ping(): Promise<boolean>
  /** 按 compose service label 找容器(all=true 含 stopped)。不按名字硬编码 —— project 前缀因部署而异。 */
  listByService(service: string): Promise<DockerContainer[]>
  start(id: string): Promise<void>
  stop(id: string): Promise<void>
  /** host 档:唤醒后查随机宿主口。Ports 空(容器停着)→ null;调用方视为唤醒失败。 */
  inspectHostPort(id: string, containerPort: number): Promise<number | null>
  /** 镜像不在本地就拉。已在本地则立刻返回。拉取是流式响应,读完为止。 */
  pullImage(image: string): Promise<void>
  /** 创建容器(不启动),返回 id。 */
  createContainer(spec: ContainerSpec): Promise<string>
  /** 删除容器(force)。已不存在视为成功。 */
  removeContainer(id: string): Promise<void>
  /** 确保网络存在(已存在视为成功)。 */
  ensureNetwork(name: string): Promise<void>
  /** 容器现状:running / exited / 不存在,以及它当前用的镜像。 */
  inspectState(id: string): Promise<{ running: boolean; image: string } | null>
  /** 最后 `tail` 行日志(stdout+stderr 合流,带 RFC3339 时间戳,已解帧)。容器不存在 → null。
   *  其余 HTTP 错误照常抛 —— 「docker 够不着」和「这个容器没有」是两件事,路由要分别说。 */
  logs(id: string, tail: number): Promise<string[] | null>
  /** 容器内跑一条命令到退出，回 `{ exitCode, output }`（stdout+stderr 合流、已解帧）。非零退出码**不抛**——
   *  「admin set 失败算不算失败」由调用方定。容器不在 / daemon 够不着才抛。 */
  exec(id: string, cmd: string[]): Promise<{ exitCode: number; output: string }>
}

/** standby 的查找键。compose 建的容器带的是同一个 label(project 前缀因部署而异,所以从来不按名字找)。 */
export const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service'
/** 「这个容器是后端自己建的」——用来和 compose 建的那些区分开(升级/清理只动自己建的)。 */
export const MANAGED_LABEL = 'app.stream.managed'

/** 后端自建容器的名字。compose 建的叫 `<project>-<service>-1`,这里不带 `-1`,不会撞上。 */
export function managedContainerName(service: string): string {
  return `stream-${service}`
}

const MEM_UNITS: Record<string, number> = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }

/** `'8G'` → 字节。解析不了 **抛错**,绝不回落成 0——0 在 docker 里是"不限制",
 *  一个写错的 mem 会静默变成"随便吃满宿主内存",正是最坏的那种失败。 */
export function parseMemBytes(v: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([bkmgt])?(?:i?b)?\s*$/i.exec(v)
  const unit = m?.[2] ? MEM_UNITS[m[2].toLowerCase()] : 1
  const n = m ? Number(m[1]) * (unit ?? 1) : NaN
  if (!Number.isFinite(n) || n <= 0) throw new Error(`unparseable mem limit: ${JSON.stringify(v)}`)
  return Math.round(n)
}

/** 「这个挂载是不是宿主路径 bind」——命名卷 = 源段是个裸名字(没有路径分隔符、不是相对/绝对
 *  路径、不是盘符)。**这条判据全仓只有这一份**:运行时(下面的 createContainer)和安装期
 *  (`src/packages/container-policy.ts` 钳制第三方声明)共用它。两份分家 = "运行时拒、安装期放"
 *  (或反过来),而两边单看都正常。 */
export function isHostBindMount(mount: string): boolean {
  const src = mount.split(':')[0] ?? ''
  const isDriveLetter = /^[A-Za-z]$/.test(src) && /^[A-Za-z]:[\\/]/.test(mount)
  return (
    !src || src.includes('/') || src.includes('\\') || src.startsWith('.') || src.startsWith('$') || isDriveLetter
  )
}

/** 宿主路径 bind 会把宿主文件系统交给容器,不接受;不许它静默降级,直接拒。 */
function assertNamedVolume(mount: string): void {
  if (isHostBindMount(mount)) {
    throw new Error(`only named volumes are allowed (got host bind): ${mount} —— 只接受命名卷 name:/path`)
  }
}

/**
 * Docker 日志流 → 一行一条。
 *
 * **非 TTY 容器的日志流不是纯文本**,是重复的帧:`[stream_type(1) 00 00 00 size(4BE)] payload`。
 * stream_type 1=stdout 2=stderr。size 是任意四个字节,所以**解帧必须在 Buffer 上做**——
 * 先按 utf8 解成字符串再切,size 里任何 ≥0x80 的字节都会变成 U+FFFD,字节位置从此对不齐,
 * 而表现只是"日志行开头多了几个乱码",看起来像编码问题、不像逻辑错。
 *
 * payload 按帧切,但**解码只做一次**(全部帧拼起来再 toString):一个多字节字符完全可能被
 * daemon 切在两帧之间,逐帧解码会在接缝处产生乱码。
 *
 * TTY 容器**没有帧头**(`docker run -t`)。判据是"首字节 ≤2 且随后三个字节为 0",不成立就把
 * 剩下的整段当裸文本——不能把第一个字节当 size 吃掉。
 */
export function decodeDockerLogStream(raw: Buffer): string[] {
  const parts: Buffer[] = []
  let i = 0
  while (i < raw.length) {
    const framed =
      i + 8 <= raw.length && raw[i]! <= 2 && raw[i + 1] === 0 && raw[i + 2] === 0 && raw[i + 3] === 0
    if (!framed) {
      parts.push(raw.subarray(i))
      break
    }
    const end = Math.min(i + 8 + raw.readUInt32BE(i + 4), raw.length)
    parts.push(raw.subarray(i + 8, end))
    i = end
  }
  return Buffer.concat(parts)
    .toString('utf8')
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.length > 0)
}

/** DOCKER_HOST(unix:// | npipe:// | tcp://)> 平台默认(win32→npipe,其余→/var/run/docker.sock)。
 *  解析不了 → null(调用方降级直通,绝不 throw)。 */
export function resolveDockerEndpoint(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): DockerEndpoint | null {
  const h = env.DOCKER_HOST
  if (h) {
    if (h.startsWith('unix://')) return { socketPath: h.slice('unix://'.length) }
    if (h.startsWith('npipe://')) return { socketPath: h.slice('npipe://'.length).replace(/\//g, '\\') }
    if (h.startsWith('tcp://')) {
      try {
        const u = new URL(h)
        return { host: u.hostname, port: Number(u.port || 2375) }
      } catch { return null }
    }
    return null
  }
  return platform === 'win32' ? { socketPath: '\\\\.\\pipe\\docker_engine' } : { socketPath: '/var/run/docker.sock' }
}

const defaultRequest: RawRequest = (ep, method, path, timeoutMs = 5000, body) =>
  new Promise((resolve, reject) => {
    let settled = false
    // 两条 error 来源(req 级 vs res 级)都可能触发、且都要能在 body 读到一半时打断 —— 用 settled 闸门保证只 resolve/reject 一次。
    const settle = (fn: () => void) => { if (!settled) { settled = true; fn() } }
    // Content-Length 必须按 **Buffer 字节数** 算,不是字符串长度:env 值里有中文时字符数 < 字节数,
    // 少报的那部分 daemon 会一直等,既不报错也不回包,表现是请求挂到超时——极难查。
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
    const headers = payload
      ? { 'Content-Type': 'application/json', 'Content-Length': payload.byteLength }
      : undefined
    const req = http.request(
      ep.socketPath
        ? { socketPath: ep.socketPath, path, method, headers }
        : { host: ep.host, port: ep.port, path, method, headers },
      (res) => {
        // 攒 Buffer 而不是 `body += c`:后者对每个 chunk 各做一次 utf8 解码,多字节字符被切在
        // chunk 边界就乱码;而日志流还需要原始字节来解帧(见 decodeDockerLogStream)。
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => settle(() => {
          const raw = Buffer.concat(chunks)
          resolve({ status: res.statusCode ?? 0, body: raw.toString('utf8'), raw })
        }))
        // Docker daemon 中途断连(响应体读到一半 socket 被关)会在 res 上单独发 error,
        // 和 req 的 error 是两条独立的事件源。不接:轻则这个 promise 永远不 settle(调用方
        // 挂死,standby 判定卡住而不是降级),重则触发 Node 对未监听 'error' 的默认处理、
        // 把进程带走 —— 两种结果都违反"Docker 异常时安静降级"的契约,必须让它规规矩矩 reject。
        res.on('error', (err) => settle(() => reject(err)))
      },
    )
    req.on('error', (err) => settle(() => reject(err)))
    req.setTimeout(timeoutMs, () => req.destroy(new Error('docker API timeout')))
    req.end(payload)
  })

export function makeDockerClient(ep: DockerEndpoint, requestImpl: RawRequest = defaultRequest): DockerClient {
  return {
    async ping() {
      try { return (await requestImpl(ep, 'GET', '/_ping')).status === 200 } catch { return false }
    },
    async listByService(service) {
      const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.service=${service}`] }))
      const r = await requestImpl(ep, 'GET', `/containers/json?all=true&filters=${filters}`)
      if (r.status !== 200) throw new Error(`docker list HTTP ${r.status}: ${r.body.slice(0, 200)}`)
      return JSON.parse(r.body) as DockerContainer[]
    },
    async start(id) {
      // 冷 GPU 容器(如声纹引擎)实测冷启动 40s+,默认 5s 请求超时会在 daemon 已经把容器
      // 起起来之后先一步超时抛错,导致 wake() 整体失败、首发请求 502(容器其实照起,下一发就通)。
      // 只放宽 start,其余端点保持 5s 默认——daemon 真挂死时 ping/list/stop 仍要能快速失败,
      // 不能因为个别操作慢就把"卡住"的语义也一起放大。
      const r = await requestImpl(ep, 'POST', `/containers/${id}/start`, 60_000)
      if (r.status !== 204 && r.status !== 304) throw new Error(`docker start HTTP ${r.status}: ${r.body.slice(0, 200)}`)
    },
    async stop(id) {
      // ?t=10 让 daemon 等 10s 优雅停止再 kill;5s 的默认请求超时比这更紧,会在 daemon 还没来得及
      // 回 204 时先超时。给够 15s(10s 优雅等待 + 余量),别让请求超时抢在 daemon 自己的 t=10 之前触发。
      const r = await requestImpl(ep, 'POST', `/containers/${id}/stop?t=10`, 15_000)
      if (r.status !== 204 && r.status !== 304) throw new Error(`docker stop HTTP ${r.status}: ${r.body.slice(0, 200)}`)
    },
    async inspectHostPort(id, containerPort) {
      const r = await requestImpl(ep, 'GET', `/containers/${id}/json`)
      if (r.status !== 200) throw new Error(`docker inspect HTTP ${r.status}: ${r.body.slice(0, 200)}`)
      const parsed = JSON.parse(r.body) as {
        NetworkSettings?: { Ports?: Record<string, { HostIp?: string; HostPort?: string }[] | null> }
      }
      const maps = parsed.NetworkSettings?.Ports?.[`${containerPort}/tcp`] ?? []
      // loopback 绑定优先(我们只发布 127.0.0.1);实测停着的容器 Ports 为空 → null
      const hit = maps.find((m) => m.HostIp === '127.0.0.1') ?? maps[0]
      const n = hit?.HostPort ? Number(hit.HostPort) : NaN
      return Number.isFinite(n) ? n : null
    },
    async pullImage(image) {
      // 先看本地有没有。有就一个字节都别拉——发行版用户每次启动都会走这条路。
      const have = await requestImpl(ep, 'GET', `/images/${encodeURIComponent(image)}/json`)
      if (have.status === 200) return
      // 拉取是**流式**响应:daemon 一边下载一边写 JSON 行,HTTP 头早在第一个字节时就回了 200。
      // 只看状态码就返回 = 镜像还没拉完就说"拉好了",紧接着的 create 报"no such image"。
      // requestImpl 读到 res 的 'end' 才 resolve,所以这里拿到 body 就意味着流已经结束。
      // 超时给 600s:几百 MB 的镜像,默认 5s(甚至 start 的 60s)都会半路砍断。
      const r = await requestImpl(ep, 'POST', `/images/create?fromImage=${encodeURIComponent(image)}`, 600_000)
      if (r.status < 200 || r.status >= 300) {
        throw new Error(`docker pull ${image} HTTP ${r.status}: ${r.body.slice(0, 200)}`)
      }
      // 拉失败时 daemon 仍回 200,错误只出现在流的最后一行里({"errorDetail":…})。不看就等于没检查。
      const failed = r.body.split('\n').filter(Boolean).find((line) => {
        try { return typeof (JSON.parse(line) as { error?: unknown }).error === 'string' } catch { return false }
      })
      if (failed) throw new Error(`docker pull ${image} failed: ${failed.slice(0, 200)}`)
    },
    async createContainer(spec) {
      // 先把会抛的校验全做完再发请求:配置错了不该在 daemon 里留下半个容器。
      for (const v of spec.volumes ?? []) assertNamedVolume(v)
      const memBytes = spec.mem ? parseMemBytes(spec.mem) : undefined
      const hostConfig: Record<string, unknown> = { NetworkMode: spec.network }
      if (spec.volumes?.length) hostConfig.Binds = spec.volumes
      if (memBytes !== undefined) {
        // MemorySwap = Memory ⇒ swap 额度为零(和 compose 那边的 memswap_limit 一致,跑飞的容器
        // 不会把宿主拖进 swap 抖动)。
        hostConfig.Memory = memBytes
        hostConfig.MemorySwap = memBytes
      }
      if (spec.publishLoopback) {
        // HostPort 空串 = 让内核随机分配;只绑 127.0.0.1,不占对外端口预算(host 档那扇门)。
        hostConfig.PortBindings = { [`${spec.port}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: '' }] }
      }
      if (spec.gpu) {
        hostConfig.DeviceRequests = [{ Driver: 'nvidia', Count: 1, Capabilities: [['gpu']] }]
      }
      // 不设 RestartPolicy:standby 是**故意**把容器停下来省资源的,自动重启会和它对着干。
      const body = {
        Image: spec.image,
        ...(spec.user ? { User: spec.user } : {}),
        Env: Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${v}`),
        ExposedPorts: { [`${spec.port}/tcp`]: {} },
        // 这两个 label 是命脉:standby 的 listByService 按 compose service label 过滤,
        // 缺了它容器起着但永远找不到、唤醒必失败;managed 标记用来区分"我建的"和 compose 建的。
        Labels: { [COMPOSE_SERVICE_LABEL]: spec.service, [MANAGED_LABEL]: '1' },
        HostConfig: hostConfig,
      }
      const name = encodeURIComponent(managedContainerName(spec.service))
      const r = await requestImpl(ep, 'POST', `/containers/create?name=${name}`, 30_000, body)
      if (r.status !== 201) throw new Error(`docker create HTTP ${r.status}: ${r.body.slice(0, 200)}`)
      const id = (JSON.parse(r.body) as { Id?: string }).Id
      if (!id) throw new Error(`docker create returned no Id: ${r.body.slice(0, 200)}`)
      return id
    },
    async removeContainer(id) {
      // 404 = 已经不在了,正是想要的终态,不是错误。
      const r = await requestImpl(ep, 'DELETE', `/containers/${id}?force=true`, 30_000)
      if (r.status !== 204 && r.status !== 404) {
        throw new Error(`docker remove HTTP ${r.status}: ${r.body.slice(0, 200)}`)
      }
    },
    async ensureNetwork(name) {
      // 409 = 已存在(compose 或上一次启动建的),同样是想要的终态。
      const r = await requestImpl(ep, 'POST', '/networks/create', undefined, { Name: name, CheckDuplicate: true })
      if (r.status !== 201 && r.status !== 409) {
        throw new Error(`docker network create HTTP ${r.status}: ${r.body.slice(0, 200)}`)
      }
    },
    async inspectState(id) {
      const r = await requestImpl(ep, 'GET', `/containers/${id}/json`)
      if (r.status === 404) return null
      if (r.status !== 200) throw new Error(`docker inspect HTTP ${r.status}: ${r.body.slice(0, 200)}`)
      const parsed = JSON.parse(r.body) as { State?: { Running?: boolean }; Config?: { Image?: string } }
      return { running: parsed.State?.Running === true, image: parsed.Config?.Image ?? '' }
    },
    async logs(id, tail) {
      // timestamps=1 不是可选的讲究:没有它,一屏日志看不出"这是刚才那次崩溃还是三天前的",
      // 而排障时这恰恰是第一个要回答的问题。
      const path = `/containers/${id}/logs?stdout=1&stderr=1&timestamps=1&tail=${tail}`
      // 15s:日志是一次性读完的有界响应(tail 上限 1000 行),但容器刚崩时 daemon 偶尔慢半拍,
      // 5s 的默认值会把"能看到原因"变成"超时了什么都没有"。
      const r = await requestImpl(ep, 'GET', path, 15_000)
      if (r.status === 404) return null
      if (r.status !== 200) throw new Error(`docker logs HTTP ${r.status}: ${r.body.slice(0, 200)}`)
      return decodeDockerLogStream(r.raw ?? Buffer.from(r.body, 'utf8'))
    },
    async exec(id, cmd) {
      // 三步：建 exec 实例 → attach 起它（响应体就是输出流，同日志一样带 8 字节帧头）→ 问退出码。
      // `Detach:false` 让 start 一直读到命令退出才返回；30s 够 `openlist admin set` 这类一秒级命令。
      const created = await requestImpl(ep, 'POST', `/containers/${id}/exec`, 10_000, { Cmd: cmd, AttachStdout: true, AttachStderr: true })
      if (created.status !== 201) throw new Error(`docker exec create HTTP ${created.status}: ${created.body.slice(0, 200)}`)
      const execId = (JSON.parse(created.body) as { Id?: string }).Id
      if (!execId) throw new Error(`docker exec create returned no Id: ${created.body.slice(0, 200)}`)
      const started = await requestImpl(ep, 'POST', `/exec/${execId}/start`, 30_000, { Detach: false, Tty: false })
      if (started.status !== 200) throw new Error(`docker exec start HTTP ${started.status}: ${started.body.slice(0, 200)}`)
      const output = decodeDockerLogStream(started.raw ?? Buffer.from(started.body, 'utf8')).join('\n')
      const inspected = await requestImpl(ep, 'GET', `/exec/${execId}/json`)
      if (inspected.status !== 200) throw new Error(`docker exec inspect HTTP ${inspected.status}: ${inspected.body.slice(0, 200)}`)
      const exitCode = (JSON.parse(inspected.body) as { ExitCode?: number }).ExitCode ?? -1
      return { exitCode, output }
    },
  }
}
