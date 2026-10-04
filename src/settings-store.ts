import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { TrackSyncFn } from './op-track.ts'
import { ConfigRowRegistry } from './settings/config-rows.ts'

/**
 * settings 覆盖层里属于 LLM 的那一点点东西：**只有摘要 prompt**。
 *
 * 连接不在这儿。**LLM 连接就是 `llm` Provider 行的成员**（`baseUrl`/`model` 在成员自己的
 * `params` 上，key 经 `params.tokenName` 从 TokenProvider 取），一种形状、一个入口。
 * 这里曾经还有 `connections[]` + per-任务 `tasks` 绑定，成员则写一个 `connectionId` 指过来——
 * 于是同一件事有两种形状、两个真相源，"设置页配好了却报 LLM 未配置"就是这么来的。整条腿已退役。
 */
export interface LlmSettings {
  /** user-editable, language-neutral summary prompt; blank → backend default */
  prompt?: string
}

/** 摘要 prompt + LLM 就绪状态（Providers 页的 llm.summarize 卡片读它）。
 *  `configured` 判的是**梯子**：`llm` 行上至少有一个成员端点齐全（baseUrl+key+model）。
 *  以前判的是 LlmSettings 里的任务绑定——那张表已经不是调用路径的真相源了。 */
export interface SummaryPromptStatus {
  prompt: string
  configured: boolean
}

/**
 * 从 `settings.json` 里那块 `llm` 读出**唯一还有效的字段：prompt**。
 *
 * 存量数据可能是三代形状之一：扁平 `{baseUrl,apiKey,model,prompt}`、v2 `{connections,tasks,prompt}`、
 * 或者已经只剩 `{prompt}`。三者里 prompt 的位置都一样，所以不需要分代——**其余字段一律不再读**：
 * 连接已经是 `llm` Provider 行的成员，那才是真相源。读到一堆 inert 的旧字段是正常的，忽略即可。
 * 纯函数，便于单测。
 */
export function migrateLlmSettings(raw: unknown): LlmSettings | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  return typeof r.prompt === 'string' ? { prompt: r.prompt } : undefined
}

/** AList connection overlay (URL + permanent token), layered over config.yaml / env.
 *  Editable from the plugin config dialog; token never echoed back. */
export interface AlistSettings {
  url?: string
  token?: string
  /** Bootstrap 接管序列生成的 admin 密码（内置托管专用；48h JWT 过期后自动重登）。
   *  与 token 同一安全域（settings.json），永不回显到 UI。 */
  adminPassword?: string
  /** 挂载网盘期望态（reconciler 的唯一事实来源；AList storage 只是执行结果）。 */
  mounts?: AlistMountEntry[]
}

/** 一条挂载期望：preset id + 可选自定义挂载点（缺省用 preset.mountPath）。 */
export interface AlistMountEntry {
  presetId: string
  mountPath?: string
}

/** Credentials and lookup language for the built-in TMDb/OMDb Sources. Provider member order
 *  lives in stream.db; this only configures the external facilities those Sources call. */
export interface VideoSourceSettings {
  tmdbApiKey?: string
  omdbApiKey?: string
  language?: string
}

/** Source-owned runtime configuration. Values are private deployment state; field semantics
 * (including which keys are secrets) are declared by the Source manifest, never inferred here. */
export type RuntimeConfigValues = Record<string, unknown>

export interface RuntimeConfigStatus {
  values: RuntimeConfigValues
  secrets: Record<string, { configured: boolean; origin: 'file' }>
}

/** User-editable runtime settings, layered over config.yaml defaults. */
export interface StreamSettings {
  llm?: LlmSettings
  /** AList backend overlay (plugin config dialog); layered over config.alist_* / env. */
  alist?: AlistSettings
  videoSources?: VideoSourceSettings
  /** Manifest-declared Source runtime configuration keyed by `runtime_config.ref`. */
  runtimeConfigs?: Record<string, RuntimeConfigValues>
  /** 采集用哪个 Chrome（用户在入口里选的那个）。层叠在 config.yaml 的 `harvest_browser` 之上——
   *  config 是默认，这里是用户的现场选择。只存 exe：profile/args 那些仍归 config.yaml。 */
  harvest_browser?: { exe: string }
  /** Per-plugin enable flags keyed by plugin id. Opt-OUT model: an ABSENT entry means enabled,
   *  so brand-new/unknown plugins default on and existing installs keep every plugin. Only
   *  explicit `false` disables. Required plugins ignore this map (always enabled). */
  plugins?: Record<string, boolean>
  /** 配置 row 的用户层（config-rows 引擎的唯一落盘处）。旧键（videoSources/llm/harvest_browser）
   *  经各 row 的 legacy 投影垫底，首次 PUT 后由这里接管。 */
  rows?: Record<string, Record<string, unknown>>
  /** 扩展安装引导的用户态。**只记"拒绝过"，不记"装成功了"**——装没装成的真相源是
   *  `browser-capability`（连上过就是装了），在这里再存一份就会有两个真相。 */
  extension_onboarding?: { declinedAt?: string }
}

/**
 * Runtime settings overlay (edited via the UI), persisted as JSON so it survives restarts
 * and layered over config.yaml — config.yaml stays the untouched default source, this file
 * holds the user's live overrides.
 */
export class SettingsStore {
  /** 配置 row 引擎（spec 2026-08-17-config-rows-slice1）。row 由各归属域注册
   *  （settings 域: video-sources / agent 域: summary-prompt / harvest 域: harvest-browser），
   *  读写经 `rows.resolve/put`；本类的 rowValues/setRowValues 只是它的落盘面。 */
  readonly rows = new ConfigRowRegistry(this)

  constructor(
    private readonly path: string,
    /** loop-lag attribution (op-track): every setter rewrites the WHOLE file synchronously,
     *  a known stall suspect — bill it to a `settings-write` span when a tracker is wired. */
    private readonly trackSync?: TrackSyncFn
  ) {}

  /** Single write gate: whole-file synchronous rewrite, wrapped in a settings-write span.
   *
   *  **0600，和 `data/cookies.json` 同级**：这个文件是凭据存储——`runtimeConfigs` 里躺着
   *  各家的 API key，recipe 的 `secret_params` 也从这儿取（东方财富的资金账号/交易密码就在
   *  其中）。默认 644 意味着同机任何用户都读得到，而在 WSL 上 Windows 侧也够得着。
   *  写完再 chmod：`writeFileSync` 的 mode 只在**新建**时生效，覆盖既有文件不改权限，
   *  所以存量那份 644 只靠 mode 参数永远修不回来（同 `session-export.ts`）。 */
  private persist(next: unknown): void {
    const write = () => {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, JSON.stringify(next, null, 2), { mode: 0o600 })
      chmodSync(this.path, 0o600)
    }
    if (this.trackSync) this.trackSync('settings-write', write)
    else write()
  }

  get(): StreamSettings {
    if (!existsSync(this.path)) return {}
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as StreamSettings & { llm?: unknown }
      if (raw.llm !== undefined) raw.llm = migrateLlmSettings(raw.llm) // 读时把旧形状升 v2
      return raw as StreamSettings
    } catch {
      return {} // corrupt overlay → fall back to config.yaml defaults
    }
  }

  /** 用户对扩展安装引导的态度。缺席 = 还没被问过（首启横幅据此决定提不提）。 */
  extensionOnboarding(): { declinedAt?: string } {
    return this.get().extension_onboarding ?? {}
  }

  /** 记下「以后再说」。`now` 由调用方给（ISO 串），这里不读时钟——端点那一层才有时钟。 */
  declineExtensionOnboarding(now: string): void {
    this.persist({ ...this.get(), extension_onboarding: { declinedAt: now } })
  }

  // ── 配置 row 的落盘面（ConfigRowStore 契约；语义在 config-rows.ts） ────────────
  // 旧的 setHarvestBrowser / setSummaryPrompt / setVideoSources 手写 setter 已退役：
  // 写路径统一走 `rows.put(<rowId>, …)`（密文保留/空串清空/校验都在引擎里，只此一份）。

  rowValues(id: string): Record<string, unknown> | undefined {
    return this.get().rows?.[id]
  }

  setRowValues(id: string, values: Record<string, unknown>): void {
    const current = this.get()
    this.persist({ ...current, rows: { ...(current.rows ?? {}), [id]: values } })
  }

  clearRowValues(id: string): void {
    const current = this.get()
    const rows = { ...(current.rows ?? {}) }
    delete rows[id]
    this.persist({ ...current, rows })
  }

  /** 持久化挂载期望态（reconciler 的输入）。不触碰凭证字段。
   *  （UI 的 url/token 写路径已收进 `alist` 配置 row——rows.put('alist')，
   *  密文空串保留在引擎里；旧的 setAlist 手写 setter 已退役。） */
  setAlistMounts(mounts: AlistMountEntry[]): void {
    const prev = this.get().alist
    const next: AlistSettings = { ...prev, mounts }
    this.persist({ ...this.get(), alist: next })
  }

  /** Resolve one Source configuration ref. Legacy video settings are projected here so an
   * upgrade keeps existing credentials usable before the first Source Config Sheet save.
   * TMDb/OMDb 的投影读 `video-sources` row（注册了才走——裸构造的 store 没有 row，回落旧键），
   * 这样用户在新表单里改的 key 立刻流进 Source 侧，不出现两份真相。 */
  runtimeConfig(ref: string): RuntimeConfigValues {
    const raw = this.get()
    const stored = raw.runtimeConfigs?.[ref]
    if (stored) return { ...stored }
    const video = this.rows.has('video-sources')
      ? (this.rows.userValues('video-sources') ? this.rows.resolve('video-sources') : undefined)
      : raw.videoSources
    if (ref === 'tmdb' && video) {
      return { apiKey: video.tmdbApiKey, language: (video.language as string | undefined) ?? 'zh-CN' }
    }
    if (ref === 'omdb' && video?.omdbApiKey) return { apiKey: video.omdbApiKey }
    if (ref === 'llm-openai' && raw.llm) return { ...raw.llm }
    return {}
  }

  /** Write a Source-owned configuration. Blank secret inputs preserve the existing secret so
   * write-only config sheets never need to round-trip sensitive values. */
  setRuntimeConfig(ref: string, values: RuntimeConfigValues, secretKeys: string[]): void {
    const previous = this.runtimeConfig(ref)
    const secrets = new Set(secretKeys)
    const merged: RuntimeConfigValues = { ...previous, ...values }
    for (const key of secrets) {
      if (values[key] === '') merged[key] = previous[key]
    }
    const current = this.get()
    this.persist({
      ...current,
      runtimeConfigs: { ...(current.runtimeConfigs ?? {}), [ref]: merged },
    })
  }

  /** Public-safe view: ordinary values are returned; secrets yield status and origin only. */
  // ── source family 的裸存量面（config-rows slice3；status/密文投影已归引擎） ──────

  runtimeConfigRecord(ref: string): RuntimeConfigValues | undefined {
    return this.get().runtimeConfigs?.[ref]
  }

  setRuntimeConfigRecord(ref: string, record: RuntimeConfigValues): void {
    const current = this.get()
    this.persist({ ...current, runtimeConfigs: { ...(current.runtimeConfigs ?? {}), [ref]: record } })
  }

  clearRuntimeConfigRecord(ref: string): void {
    const current = this.get()
    const runtimeConfigs = { ...(current.runtimeConfigs ?? {}) }
    delete runtimeConfigs[ref]
    this.persist({ ...current, runtimeConfigs })
  }

  /** Bootstrap 接管序列写入托管凭证（密码 + 48h JWT）。**token 走 row**（`rows.alist.token`，
   *  与用户 UI 同一条写路径——两处各写一份的话，用户写过一次 row 之后 bootstrap 刷新的 JWT
   *  就永远被 row 挡住，静默失效）；adminPassword 不是 row 字段（bootstrap 内部凭证，永不进
   *  表单），留在 legacy alist 块。一次原子 persist；用户配的 url overlay 原样保留。 */
  setAlistCredentials(creds: { password: string; token: string }): void {
    const current = this.get()
    this.persist({
      ...current,
      alist: { ...current.alist, adminPassword: creds.password },
      rows: {
        ...(current.rows ?? {}),
        alist: { ...(current.rows?.alist ?? {}), token: creds.token },
      },
    })
  }

  /** Flip one plugin's enable flag and persist. Writing `true` records an explicit enable
   *  (same as absent, but survives if the default ever changes). */
  setPluginEnabled(id: string, enabled: boolean): void {
    const plugins = { ...(this.get().plugins ?? {}), [id]: enabled }
    this.persist({ ...this.get(), plugins })
  }
}
