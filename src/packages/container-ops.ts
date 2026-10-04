/**
 * 「包」页对一个容器能做的两件事：**看日志**、**重启**。
 *
 * 为什么单独一层（而不是在路由里直接调 docker）：这两件事的安全属性——「docker 怎么坏都不
 * 掀翻请求」「`manage_containers` 关着时不擅自创建容器」「找容器按 `backend.service` 不按包 id」
 * ——只有在它能被单独调用时才测得到。`provision-wire.ts` / `standby/wire.ts` 是同一个立场。
 *
 * **不新写容器生命周期**：重启复用 `provisionBackend`（它已经会 start / 按镜像重建 / 等健康）。
 * 另写一套 = 多一份会和 standby、和 `/api/plugins` 说法不一致的真相源。
 *
 * 三种失败必须**分开**说，合成一个 500 就等于把用户支去查错的地方：
 *  - `no_container`  这个包压根没有容器槽，或者容器从没建起来 → 没什么可看的
 *  - `unavailable`   docker 够不着 / 这台机器上就没有容器这条路 → 不是包的问题
 *  - `not_managed`   容器不存在，而宿主没被授权替你建 → 出路是用户自己 `docker compose up -d`
 */
import type { PluginDescriptor } from '../plugins/types.ts'
import type { PluginNetMode } from '../plugins/plugin-target.ts'
import {
  resolveDockerEndpoint,
  makeDockerClient,
  type DockerClient,
  type DockerContainer,
  type DockerEndpoint,
} from '../plugins/standby/docker-api.ts'
import { provisionBackend } from '../plugins/provisioner.ts'

/** 与 compose 生成器、provision-wire 同一个网络名——三条路产出的容器必须同网。 */
const NETWORK = 'stream'

export type ContainerOpsCode = 'no_container' | 'unavailable' | 'not_managed'

export type ContainerOpsOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; code: ContainerOpsCode; message?: string }

export interface ContainerLogs {
  lines: string[]
  /** 行数顶到了 tail —— 上面还有，不是「就这么多」。 */
  truncated: boolean
}

export interface ContainerRestart {
  state: 'running' | 'error'
  /** state==='error' 时的原话。包装成「重启失败」等于把唯一有用的信息扔掉。 */
  error?: string
}

export interface ContainerOpsDeps {
  /** 两层合起来的描述符（内置 + 用户装的第三方）。**每次调用现取**：刚装的包不在启动快照里。 */
  descriptors: () => PluginDescriptor[]
  mode: PluginNetMode
  /** `config.manage_containers`。只决定「容器不存在时要不要替你建」，不挡重启已有容器。 */
  manageEnabled: boolean
  /** 下面都是注入点，默认即生产实现。 */
  network?: string
  resolveEndpoint?: () => DockerEndpoint | null
  makeClient?: (ep: DockerEndpoint) => DockerClient
  provision?: typeof provisionBackend
}

export interface ContainerOps {
  logs(pkgId: string, tail: number): Promise<ContainerOpsOutcome<ContainerLogs>>
  restart(pkgId: string): Promise<ContainerOpsOutcome<ContainerRestart>>
}

const serviceOf = (p: PluginDescriptor): string => p.backend?.service ?? p.id

/** 多个残留时挑 running 那个。挑错了会去读一个几天前退出的容器——它有内容、有时间戳，
 *  看起来完全正常，只是说的不是这次的事。与 standby / provisioner 的挑法一致。 */
const pickContainer = (list: DockerContainer[]): DockerContainer | undefined =>
  list.find((c) => c.State === 'running') ?? list[0]

export function makeContainerOps(deps: ContainerOpsDeps): ContainerOps {
  const fail = <T>(code: ContainerOpsCode, message?: string): ContainerOpsOutcome<T> =>
    message === undefined ? { ok: false, code } : { ok: false, code, message }

  /** 找到这个包的 backend 声明 + 一个能用的 docker 连接。任一步不成立就给出该说的那种失败。 */
  async function open(pkgId: string): Promise<
    { ok: true; p: PluginDescriptor; service: string; docker: DockerClient } | { ok: false; code: ContainerOpsCode }
  > {
    const p = deps.descriptors().find((d) => d.id === pkgId)
    if (!p?.backend) return { ok: false, code: 'no_container' }
    const ep = (deps.resolveEndpoint ?? (() => resolveDockerEndpoint(process.env, process.platform)))()
    if (!ep) return { ok: false, code: 'unavailable' }
    const docker = (deps.makeClient ?? makeDockerClient)(ep)
    if (!(await docker.ping().catch(() => false))) return { ok: false, code: 'unavailable' }
    return { ok: true, p, service: serviceOf(p), docker }
  }

  return {
    async logs(pkgId, tail) {
      const o = await open(pkgId)
      if (!o.ok) return fail(o.code)
      try {
        const hit = pickContainer(await o.docker.listByService(o.service))
        if (!hit) return fail('no_container')
        const lines = await o.docker.logs(hit.Id, tail)
        if (!lines) return fail('no_container')
        return { ok: true, value: { lines, truncated: lines.length >= tail } }
      } catch (e) {
        // docker 在半路上出的岔子对用户是同一件事：「现在看不了」。异常原文进 message，
        // 但**不往上抛** —— 看日志是排障动作，它自己再制造一个 500 只会掩盖真正的故障。
        return fail('unavailable', e instanceof Error ? e.message : String(e))
      }
    },

    async restart(pkgId) {
      const o = await open(pkgId)
      if (!o.ok) return fail(o.code)
      // 后端够不着容器网络时建/起容器毫无意义：健康探活会去打一个解析不了的容器 DNS，
      // 一路等到超时，然后报一个和真实原因毫无关系的错。
      if (deps.mode === 'none') {
        return fail('unavailable', 'STREAM_PLUGIN_NETWORK 未设：这台后端够不着插件容器网络')
      }
      try {
        const hit = pickContainer(await o.docker.listByService(o.service))
        if (!hit && !deps.manageEnabled) {
          return fail(
            'not_managed',
            `${o.service} 的容器还没建起来，而 manage_containers 是关着的（宿主没被授权替你建容器）。用 \`pnpm plugins compose > docker-compose.yml && docker compose up -d\` 起它，或在配置里打开 manage_containers。`,
          )
        }
        // 在跑就先停：`provisionBackend` 看见 running 会判 no-op（action:'ran'）直接返回，
        // 于是"重启"什么都没做，而按钮回了成功——一个安静的谎。停掉之后它才会走 start 那条路。
        if (hit?.State === 'running') await o.docker.stop(hit.Id)

        const provision = deps.provision ?? provisionBackend
        const r = await provision(o.docker, o.p, {
          network: deps.network ?? NETWORK,
          publishLoopback: deps.mode === 'host',
          healthTimeoutMs: (o.p.backend?.standby?.startTimeoutSeconds ?? 60) * 1000,
          recreateOnImageMismatch: true,
        })
        return r.error
          ? { ok: true, value: { state: 'error', error: r.error.message } }
          : { ok: true, value: { state: 'running' } }
      } catch (e) {
        // provisionBackend 的契约是"绝不 throw"。仍然接住：契约哪天破了，代价不该是一个 500。
        return { ok: true, value: { state: 'error', error: e instanceof Error ? e.message : String(e) } }
      }
    },
  }
}
