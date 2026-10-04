import type { EventInput } from '../../events/store.ts'
import { DOCKER_UNREACHABLE_DEDUPE_KEY } from '../target-miss.ts'
import type { StandbyWiring } from './wire.ts'

/**
 * 开机接线的结果里，**有没有一件该告诉用户的事**。纯函数，没有 I/O。
 *
 * 为什么单独一个函数：`wireStandby` 的降级承诺是「任何失败都只留一行日志，绝不掀翻 main()」，
 * 而这条承诺被顺手扩大成了「也别说话」——于是最该说话的那一档（够不着 Docker，所有带容器的
 * 插件一起失效）成了整条链路上最安静的一档。**降级不等于闭嘴。**
 *
 * 判据只认 `docker-unreachable` 一条。另外两条 inert 是按设计如此：桌面档没有容器门、
 * 这台机器压根没插件声明 standby——它们每次开机都成立，喊了只会让用户学会忽略这个铃铛。
 *
 * 用户侧的症状长这样（2026-09-02 活体）：资源搜索只剩磁力/ed2k，网盘那几格全空，
 * 界面上看起来只是"没搜到"。真相在一行没人看的启动日志里。
 */
export function standbyInertNotification(w: StandbyWiring): EventInput | null {
  if (w.manager) return null
  if (w.inertReason !== 'docker-unreachable') return null
  const affected = w.affected ?? []
  // 没有影响面就没有要告诉用户的事——这台机器上本来也没有靠容器的插件。
  if (affected.length === 0) return null
  return {
    type: 'plugin.container',
    severity: 'error',
    title: 'Docker 不可用，带容器的插件都不会工作',
    body: `Stream 启动时连不上这台机器上的 Docker，${affected.length} 个要跑容器的插件（网盘搜索、网盘挂载、抖音等）这一轮都取不到内容——界面上看起来只是"没搜到"。把 Docker 起回来之后重启一次后端，它会重新认一遍。`,
    detail: `受影响的服务：${affected.join('、')}`,
    // 与取址那侧共用（见 DOCKER_UNREACHABLE_DEDUPE_KEY 头注）：开机时发现和真要用时发现
    // 是同一件事，占一行就够。
    dedupeKey: DOCKER_UNREACHABLE_DEDUPE_KEY,
  }
}
