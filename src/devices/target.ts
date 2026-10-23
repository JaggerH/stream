/**
 * 执行目标（browser-identity D7）：一次执行要落在哪里——一台设备、一个身份，或一个环境。
 *
 * 为什么不是「设备 + 可选身份」两格：用户在面板上选的就是三者之一（「东财放 NAS」「小红书用工作号」「采集走个人环境」），
 * 三者的失败语义也不同——设备目标认设备在不在线，身份 / 环境目标认的是「哪个节点上登着这个号」，选不出来时**绝不**
 * 退回到某台设备上。把它们拆成一个可以同时有值的结构，等于留出一条「身份没找到就按设备跑」的缝。
 *
 * 身份目标只带 `accountId`：facility 由动作 / 源所属的包给出，同一个 facility 名下的账号 id 才可比。
 */
import { LOCAL_DEVICE } from './run-context.ts'

export type Target =
  | { kind: 'device'; deviceId: string }
  | { kind: 'identity'; accountId: string }
  | { kind: 'environment'; environment: string }

/** 落库 / 路由上的三格形状：恰好一格有值。 */
export interface TargetFields {
  deviceId?: string
  accountId?: string
  environment?: string
}

export const LOCAL_TARGET: Target = Object.freeze({ kind: 'device', deviceId: LOCAL_DEVICE }) as Target

/**
 * 三格 → 目标。空串当没给；一格都没有 → `undefined`；两格以上 → 抛（存下来就没人说得清跑在哪）。
 */
export function targetFrom(f: TargetFields): Target | undefined {
  const deviceId = f.deviceId?.trim() || undefined
  const accountId = f.accountId?.trim() || undefined
  const environment = f.environment?.trim() || undefined
  const n = [deviceId, accountId, environment].filter((x) => x !== undefined).length
  if (n > 1) throw new Error('设备、身份、环境只能给一个')
  if (deviceId) return { kind: 'device', deviceId }
  if (accountId) return { kind: 'identity', accountId }
  if (environment) return { kind: 'environment', environment }
  return undefined
}

export function targetFields(t: Target): TargetFields {
  if (t.kind === 'device') return { deviceId: t.deviceId }
  if (t.kind === 'identity') return { accountId: t.accountId }
  return { environment: t.environment }
}

/** 给人看的一句：错误消息与运行记录用。 */
export function describeTarget(t: Target, facility?: string): string {
  if (t.kind === 'device') return `设备 ${t.deviceId}`
  if (t.kind === 'identity') return `身份 ${facility ? `${facility}:` : ''}${t.accountId}`
  return `环境「${t.environment}」${facility ? `里的 ${facility}` : ''}`
}

/**
 * 任务行上的覆盖（`identity` / `environment` / `device` 三列）。D7 的顺序：身份 → 环境 → 设备。
 * 路由层已拒绝同时给两个以上，这里的顺序只兜手改过库的行。
 */
export function taskTarget(row: { identity?: string; environment?: string; device?: string }): Target | undefined {
  if (row.identity) return { kind: 'identity', accountId: row.identity }
  if (row.environment) return { kind: 'environment', environment: row.environment }
  if (row.device) return { kind: 'device', deviceId: row.device }
  return undefined
}
