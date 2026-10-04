/**
 * 卸载一个第三方包时，把**这条路建出来的那个容器**收掉。
 *
 * 为什么必须有（终审 Minor 5）：卸载原本只 `rmSync` 掉包目录。容器还在跑，而下次启动它既不在
 * provision 名单里（包没了）也不在 standby 名册里（同上）——于是它变成一个**永不回收的常驻容器**，
 * 没有任何一条日志会再提到它。用户唯一的线索是内存少了一块。
 *
 * 两条边界：
 * 1. **只收自己建的那个容器。** 判据是容器名 = `managedContainerName(service)`（`stream-<service>`）。
 *    compose 建的叫 `<project>-<service>-1`，名字对不上，一根汗毛都不碰——第三方包的 id 万一
 *    与某个内置服务撞名，也不会把用户 compose 起的容器删掉。
 * 2. **docker 够不着不算失败。** 卸载是用户已经拍过板的动作，不能因为 daemon 没跑就卡住。
 *    这时返回 `'unavailable'`，由调用方说出去（"容器没清掉，需要手工 docker rm"）——
 *    静默才是真正的坑。
 *
 * 和 `manage_containers` 开关的关系：**不受它管**。那个开关管的是"要不要替你建"，而这里是
 * "我建的东西我自己收"。开关中途被关掉，已经建出来的容器仍然该由这条路收走。
 */
import {
  resolveDockerEndpoint,
  makeDockerClient,
  managedContainerName,
  type DockerClient,
  type DockerEndpoint,
} from './standby/docker-api.ts'

export type DeprovisionOutcome = 'removed' | 'absent' | 'unavailable' | 'failed'

export interface DeprovisionDeps {
  resolveEndpoint?: () => DockerEndpoint | null
  makeClient?: (ep: DockerEndpoint) => DockerClient
}

/**
 * 停掉并删除 `stream-<service>` 这个容器。**绝不 throw** —— 卸载不该因为 docker 出问题而失败。
 *
 * - `'removed'`：找到了并删掉了。
 * - `'absent'`：没有这个容器（从没建过 / 已经删了）。
 * - `'unavailable'`：docker 够不着（没装 / daemon 没跑 / socket 够不着）。
 * - `'failed'`：docker 在，但删这一步报错。
 */
export async function deprovisionService(service: string, deps: DeprovisionDeps = {}): Promise<DeprovisionOutcome> {
  const ep = (deps.resolveEndpoint ?? (() => resolveDockerEndpoint(process.env, process.platform)))()
  if (!ep) return 'unavailable'
  const docker = (deps.makeClient ?? makeDockerClient)(ep)
  if (!(await docker.ping().catch(() => false))) return 'unavailable'

  const wanted = `/${managedContainerName(service)}`
  try {
    const list = await docker.listByService(service)
    // 名字必须精确对上（docker 的 Names 带前导 `/`）。compose 建的 `<project>-<service>-1`
    // 落不进这个筛子——那是用户自己的容器。
    const mine = list.filter((c) => c.Names?.includes(wanted))
    if (mine.length === 0) return 'absent'
    for (const c of mine) {
      // stop 先行：removeContainer 是 force 删，但先优雅停能让容器有机会落盘。
      // stop 失败（容器本来就停着 / 已经没了）不该挡住删除这一步。
      await docker.stop(c.Id).catch(() => {})
      await docker.removeContainer(c.Id)
    }
    return 'removed'
  } catch {
    return 'failed'
  }
}
