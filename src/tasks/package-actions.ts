/**
 * 包提供的**动作**：`activate()` 交出来的第三样东西（前两样是 adapter / normalizer）。
 * 权威设计：docs/superpowers/specs/2026-09-02-package-action-slot-design.md
 *
 * **包提供动作，不提供定时任务。** 这条边界不是洁癖，是本仓已有的判据（`task-store.ts` 头注）：
 *
 * > 运维任务（cookie 刷新、standby 回收）是 stream 自己的内脏，改排期就该改代码走 review；
 * > 业务任务（A 股申购、数据下载）是用户的活儿，排期本来就该在 UI 里改。
 *
 * 所以"什么时候跑""跑不跑""用哪一格账号"全是**用户任务行**的事（住 db，UI 里改，改完不用
 * 重启）；包只回答"能干什么"。一条用户任务的执行体因此有两种：外部命令（`command`）或者
 * 包动作（`action`）——见 `UserTaskRow`。
 *
 * **为什么不让包自带排期**：那等于把用户的活儿写死进代码，改个时间点要发版；而且宿主得替
 * 每个包分发它的配置（`configForPackage` 里一个 `case '<包名>'`），一个设施一条特例——
 * 恰恰是这套设计要消掉的东西。
 */
import type { TaskOutcome } from './types.ts'

/**
 * 一个包提供的动作。参数来自调用它的那条任务绑定的**配置 row**（`UserTaskRow.configRef`），
 * 不来自 argv、不来自 env——那等于把交易密码摊在 `ps` 和任务列表里。
 *
 * 动作**够不到宿主内脏**：它在 `activate(ctx)` 里闭包自己的 `ctx`（`backendUrl` / `withAwake` /
 * `cookieFor` / `log` / `config` 五样），除此之外只有这个参数袋。要给动作加新能力，正确的动作
 * 是往 `PluginContext` 加一格（并回答"该不该给所有包"），不是往这个签名里塞。
 */
export type PackageAction = (params: Record<string, unknown>) => Promise<TaskOutcome>

/** 动作的全局名分隔符：`<包 id>:<动作名>`。 */
export const ACTION_SEP = ':'

/** 全局动作名。带 code 槽位的包 id 全局独占，所以包与包之间撞不了名。 */
export function actionName(pkgId: string, local: string): string {
  return `${pkgId}${ACTION_SEP}${local}`
}

/** 一个包交出来的动作表（未加前缀）。 */
export interface PackageActionEntry {
  pkgId: string
  local: string
  run: PackageAction
}

/**
 * 校验一个包交出来的动作表，失败即抛（调用方按"内置致命 / 第三方 per-package 捕获"分档）。
 * 只查这个包自己内部的事——跨包撞名不可能（前缀是独占的包 id）。
 */
export function assertPackageActions(pkgId: string, actions: Record<string, unknown>): void {
  for (const [local, fn] of Object.entries(actions)) {
    if (local.trim() === '') throw new Error(`Stream package "${pkgId}" declares an action with an empty name`)
    if (local.includes(ACTION_SEP)) {
      throw new Error(
        `Stream package "${pkgId}" declares action "${local}" containing "${ACTION_SEP}" — ` +
        `that character separates the package id from the action name`,
      )
    }
    if (typeof fn !== 'function') {
      throw new Error(`Stream package "${pkgId}" action "${local}" is not a function`)
    }
  }
}

/** 全部包动作的名录：全局名 → 实现。任务行的 `action` 字段在这里查。 */
export function actionDirectory(entries: readonly PackageActionEntry[]): Map<string, PackageAction> {
  const out = new Map<string, PackageAction>()
  for (const e of entries) out.set(actionName(e.pkgId, e.local), e.run)
  return out
}
