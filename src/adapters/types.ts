import type { SourceManifest } from '../manifest/types.ts'

/** Private runtime configuration resolved from a Source manifest ref immediately before fetch.
 * It is deliberately separate from invocation params and must never be persisted or serialized. */
export interface SourceExecutionContext {
  runtimeConfig: Record<string, unknown>
  /**
   * 「调用方还想不想要这次结果」。abort 之后 adapter 应当**停下来**，而不是跑完再被丢掉。
   *
   * 为什么这一格值得存在：拟人采集里一次 fetch 会独占某个 facility 的标签（xhs 是单标签串行）、
   * 并从它的访问预算里扣一发。用户连点两条详情时，前端只是按 correlationId 丢掉旧答案——被放弃
   * 的那次仍会跑完、仍占着 lane、仍花掉一次真实访问，于是"越点越慢"，而日志里每一次都成功。
   *
   * 不实现它的 adapter 会怎样：跑完，和以前一样——所以它是可选的，但**能停的那些必须真停**。
   */
  signal?: AbortSignal
  /**
   * 这次执行来自用户在界面上的显式操作（点了某个按钮），不是模型经工具（`stream_read`/定时调度）
   * 触发的。只有第一方 UI 路径的调用点才有资格声明它——判据是"这条调用链的唯一入口是不是一次
   * 用户点击"，不是"这个 recipe 是不是动作"（那是 `meta.action` 管的事）。
   *
   * **缺省 = 不是**：`meta.action:true` 的 recipe 在 `ReplayAdapter.fetch` 里默认一律被拒，
   * 漏声明会当场报错、不会静默放行——这是刻意的，防的是"忘了标"比"标错了"更隐蔽的那种错。
   */
  userInitiated?: boolean
}

/** The rich form of an adapter fetch result (the bare array stays legal — see `Adapter.fetch`). */
export interface AdapterFetchResult {
  items: unknown[]
  /**
   * feed title，首次采集后用来给 Stream 自动命名（scheduler → `backfillLabel`）。
   *
   * **可选，但缺席不是没有后果**：不报的 adapter 曾经让它名下的流永远停在 `xhs:xhs-home`
   * 这种占位名上。现在 scheduler 会在它缺席时从 raw items 推断（全批同一个 `author` →
   * 那就是流名，见 `inferFeedTitle`），所以只有推断兜不住、而你手里又确实有个准名字时才需要
   * 显式报——例如 alist 的目录名、browser 的页面标题。报了就优先于推断。
   */
  title?: string
  /**
   * 成功指针：这批 items 是不是"请求成功 + 解析成功"产出的、可当作上游此刻权威快照的东西。
   *
   * **缺省 true**（裸数组同）。置 `false` 的只有一种情况：本轮**没采**——环境缺席、主动 decline、
   * 隔离中。它的空不代表"上游空了"，所以 collection 流不许拿它去替换分片，它也不进请求缓存。
   * 错误路径（非 2xx / 网络错 / 解析炸 / 登录墙）继续**抛错**，那些根本到不了这里；这个字段
   * 覆盖的是"既不是错误、也不是成功"的第三种情况。见 2026-07-30 collection-empty-snapshot-guard。
   */
  authoritative?: boolean
}

/**
 * An adapter is an execution backend (RSSHub is adapter #1). It is isolated from
 * the rest of the system behind this interface; manifests name their adapter and
 * the scheduler routes invocations to the matching instance.
 */
export interface Adapter {
  /** matches SourceManifest.adapter */
  id: string
  /** apply credential env overrides before any fetch (idempotent) */
  init(envOverrides: Record<string, string>): Promise<void>
  /** fetch raw items for a manifest + params (route resolved from manifest/params).
   *  Returns a bare array (legacy) OR an `AdapterFetchResult` carrying the items plus an
   *  optional feed title and the success pointer. */
  fetch(params: Record<string, unknown>, manifest: SourceManifest, context?: SourceExecutionContext): Promise<unknown[] | AdapterFetchResult>
  /** optional auxiliary process this adapter owns; lifecycle managed by the scheduler */
  sidecar?: AdapterSidecar

  /** Optional: follow a user on this platform. Reuses auth from sidecar/browser context. */
  follow?(userId: string): Promise<void>
  /** Optional: unfollow a user on this platform. */
  unfollow?(userId: string): Promise<void>
}

/**
 * An auxiliary process an adapter owns (e.g. a signing/harvesting browser).
 * The scheduler starts it before first fetch, health-gates it, and shuts it
 * down on teardown. start() is idempotent and receives resolved credentials.
 */
export interface AdapterSidecar {
  start(creds: Record<string, string>): Promise<void>
  health(): Promise<boolean>
  shutdown(): Promise<void>
}
