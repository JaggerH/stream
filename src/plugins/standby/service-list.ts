import type { PluginDescriptor } from '../types.ts'
import { resolvePluginTarget, type PluginNetMode } from '../plugin-target.ts'
import { normalizeHealthPath } from '../health-path.ts'
import type { StandbyServiceSpec } from './manager.ts'

export interface StandbyPlan {
  /** 两道构造闸都过了吗(至少一个插件声明 standby + 网络形态不是 none)。false → serve 连
   *  Docker 端点都不用去解析。 */
  gated: boolean
  services: StandbyServiceSpec[]
  /** 解不出 target 被跳过的 service 名(日志用;host 档没有这一步,恒为空)。 */
  skipped: string[]
  /** 被管但当前处于禁用状态的 service 名(仅日志措辞用,见 planStandbyServices 注释)。 */
  disabled: string[]
}

/** 纯函数:从 descriptors 算出 standby 要管哪些服务。无 I/O、不碰 Docker——serve.ts 里原本是
 *  一段 inline 代码,谁都测不到,C1 那种"两个端口对不上"的错就是靠这种测不到的接缝活下来的。
 *
 *  两道构造闸(不可改动的既定语义):插件声明了 backend.standby,且 pluginNetMode() !== 'none'
 *  (桌面 mode=none 下插件容器根本不可达,standby 必须彻底 inert;compose/host 两档都放行,
 *  产出的 spec 形状不同——见 StandbyServiceSpec 的 healthUrl/hostProbe 注释)。
 *
 *  故意不按 isEnabled 过滤这份列表:compose.ts 生成 docker-compose.yml 时不看 enabled 状态,
 *  容器存在/running 与否跟 enabled 无关。adopt()/tick()/shutdown() 都只认这份 services——被过滤
 *  掉的插件从此在三处彻底隐形:曾启用过(容器起来、被 adopt)、后来禁用的插件会让容器无限期常驻,
 *  没有 reaper 收、日志里也看不到指向它的行。isEnabled 只用来给日志加 "(disabled)" 标注。 */
export function planStandbyServices(opts: {
  descriptors: PluginDescriptor[]
  mode: PluginNetMode
  isEnabled: (p: PluginDescriptor) => boolean
  /** 注入点(默认 resolvePluginTarget):测试要能造出"解不出 origin"的服务。 */
  resolveTarget?: (service: string, o: { descriptors: PluginDescriptor[]; mode: PluginNetMode }) => string | null
}): StandbyPlan {
  const decls = opts.descriptors.filter((p) => p.backend?.standby)
  if (decls.length === 0 || opts.mode === 'none') return { gated: false, services: [], skipped: [], disabled: [] }
  const resolveTarget = opts.resolveTarget ?? resolvePluginTarget

  const services: StandbyServiceSpec[] = []
  const skipped: string[] = []
  const disabled: string[] = []
  for (const p of decls) {
    const service = p.backend!.service ?? p.id
    if (!opts.isEnabled(p)) disabled.push(service)
    // 归一化的唯一实现在 health-path.ts(provisioner / 状态页共用同一个函数)。loader schema
    // (health: z.string().optional())不约束格式,一个声明成 "health"(不带斜杠)的 descriptor 会
    // 拼出 "http://host:porthealth";而 "@evil.com/" 这类还会把 host 整个换掉(见那个模块的头注)。
    const normalizedHealth = normalizeHealthPath(p.backend!.health)
    if (opts.mode === 'host') {
      // host 档没有静态 base:随机宿主口 start 前不存在,wake() 里 inspect 后才拼 healthUrl。
      services.push({
        service,
        idleMinutes: p.backend!.standby!.idleMinutes,
        startTimeoutSeconds: p.backend!.standby!.startTimeoutSeconds ?? 60,
        hostProbe: { containerPort: p.backend!.port, healthPath: normalizedHealth },
        aliases: service === p.id ? undefined : [p.id],
      })
      continue
    }
    // resolvePluginTarget 签名是 string | null:compose 形态下今天的 descriptor 集合总能解出值,
    // 但类型不保证——解不出 base 的服务会把 healthUrl 拼成字面量 "null/health",fetch 必败,
    // wake() 会白白耗尽整个 startTimeoutSeconds 才报一个指向错误方向的超时。构造期就跳过并点名。
    const base = resolveTarget(service, { descriptors: opts.descriptors, mode: 'compose' })
    if (!base) { skipped.push(service); continue }
    services.push({
      service,
      idleMinutes: p.backend!.standby!.idleMinutes,
      startTimeoutSeconds: p.backend!.standby!.startTimeoutSeconds ?? 60,
      healthUrl: `${base}${normalizedHealth}`,
      // MINOR F:客户端调用点写死的是插件 **id**(withAwake('voiceprint') 等),而 cell 键是
      // backend.service ?? id。今天两者对所有插件都相同,但哪天某个 descriptor 声明了不同的
      // service,withAwake 就会静默 no-op——请求打在一个已停的容器上,没有日志、没有报错、
      // 没有任何指向 standby 的线索。选"别名"而不是"唤醒未知名字时大声报警":别名让这类错误
      // **不可能发生**,报警只是让它可观测(而且要求有人正好在看日志)。别名注册的是**同一个
      // Cell**,不是第二个 cell —— 一个容器永远只有一份状态/引用计数。
      aliases: service === p.id ? undefined : [p.id],
    })
  }
  return { gated: true, services, skipped, disabled }
}

/** `[standby] managing: …` 那行的措辞:禁用的插件仍然被管(见上),标出来解释为什么一个没人
 *  调用的名字会出现在这行——而不是让人怀疑 standby 又漏过滤了。 */
export function standbyManagingLabel(plan: StandbyPlan): string {
  const disabled = new Set(plan.disabled)
  return plan.services.map((s) => (disabled.has(s.service) ? `${s.service} (disabled)` : s.service)).join(', ')
}
