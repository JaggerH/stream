import type { Context } from 'cordis'
import Schema from 'schemastery'
import { SettingsStore } from '../../settings-store.ts'
import type { TrackSyncFn } from '../../op-track.ts'

declare module 'cordis' {
  interface Context {
    /** 用户那份可写的设置覆盖层（`settings.json`）——config.yaml 之上的活配置。
     *  `settings.rows` 是配置 row 引擎（spec 2026-08-17-config-rows-slice1）。 */
    settings: SettingsStore
  }
}

export interface SettingsConfig {
  /** `settings.json` 的绝对路径（`<dataDir>/settings.json`）。 */
  path: string
  /** 整份文件同步重写是已知的 loop 卡顿嫌疑人，接了 tracker 就把它计进 `settings-write` 跨度。 */
  trackSync?: TrackSyncFn
}

/**
 * 设置覆盖层这一域：构造 `SettingsStore` 并挂成 `ctx.settings`。
 *
 * 它是 infra 层最底下那一格——运行时配置解析、插件开关、AList 覆盖层
 * 全部读它，所以它先挂；别的域用 `inject: ['settings']` 声明这层依赖，而不是靠装载顺序。
 *
 * 没有 `ctx.effect()` 包 store：这个 store 不持任何句柄（每次 setter 一次整份文件写）。
 * row 注册走 effect——域卸载时注销，重挂不会撞 duplicate。
 */
export function settingsPlugin(ctx: Context, config: SettingsConfig): void {
  const store = new SettingsStore(config.path, config.trackSync)
  ctx.provide('settings', store)

  // video-sources row：TMDb/OMDb 凭证 + 元数据语言。没有归属域（serve 直接从 store 接线），
  // 所以由 settings 域自己注册。消费方：/api/config/video-sources、旧 /api/settings/video-sources
  // 薄转发、以及 runtimeConfig('tmdb'|'omdb') 的 Source 侧投影。
  ctx.effect(() =>
    store.rows.register({
      id: 'video-sources',
      schema: Schema.object({
        tmdbApiKey: Schema.string().role('secret').description('TMDb API Key'),
        omdbApiKey: Schema.string().role('secret').description('OMDb API Key'),
        language: Schema.string().default('zh-CN').description('TMDb 元数据语言'),
      }),
      legacy: (s) => s.videoSources as Record<string, unknown> | undefined,
    })
  )
}
