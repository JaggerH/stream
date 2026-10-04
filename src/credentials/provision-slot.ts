/**
 * 「替用户把某一格 `runtime_config` 填上」这件事**唯一**的做法。
 *
 * 三步：反查谁能填（`configProvisionerFor`）→ 真去跑那条 recipe → **回头核对那一格填上了没**。
 * 第三步是它存在的全部理由：这类 recipe `allowEmpty: true`、不产 item，「建成功了」和「抽取
 * 一处没命中」在 runner 的回执里一字不差都是 `items: []`。照 runner 的回执报成功，用户会拿着
 * 一格空 key 去别处查半天。
 *
 * **为什么是一个具名模块而不是写在端点里**：今天有两个消费方——配置卡上那颗按钮走的 HTTP 端点
 * （`POST /api/source-runtime-config/provision`），和对话工作台里模型手上那个工具
 * （`provision_capability_key`）。两边各写一遍的漂移形状是静音的：一边核对、另一边不核对，
 * 于是同一次白跑在界面上是红的、在对话里是「我已经帮你申请好了」。
 */

/** 跑完之后回头问的那一份状态——只用得着 secrets 那一格。 */
export interface ProvisionStatusLike {
  secrets?: Record<string, { configured: boolean }>
}

/** 反查到的那条 recipe 的最小投影（`SourcesService.ConfigProvisioner` 的结构子集）。 */
export interface ProvisionerLike {
  sourceId: string
  field: string
  entryUrl: string
  label: string
  paramsSchema: Record<string, unknown>
}

export interface ProvisionSlotDeps<S extends ProvisionStatusLike> {
  /** ref → 能替用户申请它的那条 recipe（没有 = 这一格只能用户自己去配）。 */
  provisioner: (ref: string) => ProvisionerLike | null
  /** 真去跑它。抛错 = 这一轮在站点那一侧失败了（登录墙 / 人机验证 / 站点改版）。 */
  run: (ref: string, params: Record<string, unknown>) => Promise<void>
  /** 跑完之后**重新读**的那一份状态。绝不能用跑之前那份。 */
  statusOf: (ref: string) => S
}

export type ProvisionSlotOutcome<S extends ProvisionStatusLike> =
  | { status: 'no-provisioner'; ref: string }
  /** 跑的时候抛了。`error` 是原文——它常常直接说清是登录墙还是选择器没命中。 */
  | { status: 'failed'; ref: string; field: string; label: string; error: string }
  /** 跑完了、也没抛，但那一格还是空的。**这一档必须报失败**，见模块头注。 */
  | { status: 'ran-but-empty'; ref: string; field: string; label: string; error: string }
  | { status: 'done'; ref: string; field: string; label: string; receipt: S }

/** 「跑完了没抠到」那句话——两个消费方共用一份文案，别各写各的。 */
export function emptyAfterRunMessage(label: string, field: string): string {
  return `跑完了，但没能从 ${label} 的页面上抠到 ${field}——`
    + `可能是登录墙、人机验证没过或站点改版。失败现场看 failures/ 与 debug bus 的 recipe 频道。`
}

export async function provisionConfigSlot<S extends ProvisionStatusLike>(
  deps: ProvisionSlotDeps<S>,
  ref: string,
  params: Record<string, unknown>,
  errText: (e: unknown) => string = (e) => (e instanceof Error ? e.message : String(e)),
): Promise<ProvisionSlotOutcome<S>> {
  const p = deps.provisioner(ref)
  if (!p) return { status: 'no-provisioner', ref }
  try {
    await deps.run(ref, params)
  } catch (e) {
    return { status: 'failed', ref, field: p.field, label: p.label, error: errText(e) }
  }
  // **重新读**：`statusOf` 在这里才被调用，跑之前那份读数对这个判断毫无意义。
  const receipt = deps.statusOf(ref)
  if (!receipt.secrets?.[p.field]?.configured) {
    return { status: 'ran-but-empty', ref, field: p.field, label: p.label, error: emptyAfterRunMessage(p.label, p.field) }
  }
  return { status: 'done', ref, field: p.field, label: p.label, receipt }
}
