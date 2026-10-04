import type { Hono } from 'hono'
import type { MappingLeft } from '../netdisk/types.ts'
import type { NetdiskService } from '../netdisk/sync.ts'
import type { MappingStore } from '../netdisk/mapping-store.ts'
import type { AlistClient, AlistStorage } from '../netdisk/alist-client.ts'
import type { AlistMountEntry, SettingsStore } from '../settings-store.ts'
import type { BrowserCookie } from '../types.ts'
import { ValidationError, type ReconcileService } from '../netdisk/reconcile/service.ts'
import { OpenReconcileError, type OpenReconcileInput, type OpenReconcileResult } from '../netdisk/reconcile/open.ts'
import { unknownKey, unknownKeyMessage } from './strict-input.ts'
import type { AudioSampleOutcome } from '../netdisk/reconcile/sample-audio.ts'
import { MOUNT_PRESETS, findPreset } from '../../packages/alist/presets.ts'
import { reconcileMounts, cookiesForDomain, mountStatusOf, type CookieSource } from '../../packages/alist/mounts.ts'
import { searchableSourceTypes } from '../netdisk/source-types.ts'
import type { FollowService } from '../netdisk/follow/service.ts'
import type { AdjudicationService } from '../netdisk/adjudicate/service.ts'
import { opaqueWorkDirName } from '../video/work-binding.ts'
import { landingDirFor } from '../netdisk/save-binding.ts'
import { NETDISK_SAVE_DEST } from '../../shared/netdisk/save-dest.ts'
import { multipartBoundary, parseMultipart } from './multipart-stream.ts'
import { errText } from '../err-text.ts'
import {
  ShareCreateError,
  type ShareCreateInput, type ShareCreateOutput,
  type ShareListInput, type ShareListOutput,
  type ShareDeleteInput, type ShareDeleteOutput,
} from '../netdisk/share-create.ts'
import { createReadStream, createWriteStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export interface NetdiskDeps {
  service: NetdiskService
  store: MappingStore
  alist: AlistClient
  /** 挂载期望态持久化 + cookie 来源（缺任一 → 挂载端点 501）。 */
  settings?: SettingsStore
  fetchCookies?: CookieSource
  /** 归档器（spec §4）：未装配（如 netdisk 整体未启用）→ 挂载端点全部 503。 */
  reconcile?: ReconcileService
  /**
   * 听一段网盘音频（头尾各约两分钟的转写）——`netdisk_transcribe` 工具的取数腿。
   *
   * **这一格只服务 MCP 面，没有对应的 HTTP 端点**，和 `openReconcile` 一样住在这个包里，是
   * 因为两个消费端读的都是它（`kernel/plugins/netdisk.ts` provide 的那一份）。逐成员的归属
   * 登记在 `src/mcp/netdisk-forwarding.test.ts`。未装配（netdisk 整体未启用）→ 工具不注册。
   */
  transcribeSample?: (input: { path: string; windowS?: number }) => Promise<AudioSampleOutcome>
  /**
   * 「就地开一次整理」（spec 2026-08-25 §4.2）：订阅 + 来源目录 → 货架/绑定/下架来源/配置，
   * 四步原子、失败回滚。**装配在 serve.ts**——只有那儿同时够得着网盘域、订阅成员表和调度器
   * （补一条来源之后要重排班，不然那条来源到重启前都不会被采）。未装配 → 端点 503。
   */
  openReconcile?: (input: OpenReconcileInput) => Promise<OpenReconcileResult>
  /**
   * 影视追更（spec 2026-09-03-work-follow-loop）：开关 / 看一眼 / 手动跑一轮 / 建一部剧的追更。
   * 未装配（netdisk 整体未启用）→ 四条端点全 503。逐成员归属登记在
   * `src/mcp/netdisk-forwarding.test.ts`。
   */
  follow?: FollowService
  /**
   * 轮末裁决器（spec 2026-09-03-netdisk-llm-adjudicator）：手动入口——归档 pending 卡 + （如果调用方
   * 传了）追更候选打包问一次模型。未装配（netdisk 整体未启用）→ 两条端点 503。
   */
  adjudicate?: AdjudicationService
  /**
   * 网盘内目录 → 夸克分享链接（`POST /api/netdisk/share/create`）。装配在 `kernel/plugins/netdisk.ts`
   * （`src/netdisk/share-create.ts`：挂载表 + 宿主派发的登录态 + 路径→fid）。未装配 → 503。
   * 下游是导出脚本首发时建一次链接；逐成员归属登记在 `src/mcp/netdisk-forwarding.test.ts`。
   */
  shareCreate?: (input: ShareCreateInput) => Promise<ShareCreateOutput>
  /**
   * 建出去的链接之后归谁管（`GET /api/netdisk/share/list`）：列当前账号的分享。只读。
   * 与 `shareCreate` 同装在 `kernel/plugins/netdisk.ts`、同一口夸克 cookie。未装配 → 503。
   */
  shareList?: (input: ShareListInput) => Promise<ShareListOutput>
  /**
   * 按 shareId 批量删分享（`POST /api/netdisk/share/delete`）。删的是链接不是文件，且不可逆
   * （证据见 `shared/netdisk/quark/share-api.ts` 的 `quarkShareDelete`）。未装配 → 503。
   */
  shareDelete?: (input: ShareDeleteInput) => Promise<ShareDeleteOutput>
}

/** `ShareCreateError.code` → HTTP 状态。自建分享的三条端点（建/列/删）共用这一份。 */
const SHARE_ERROR_STATUS = { validation_error: 400, not_found: 404, unsupported: 501, unavailable: 503, upstream_error: 502 } as const

const err = (code: string, message: string) => ({ error: { code, message } })

/** `POST /api/netdisk/reconcile/decisions` 认识的字段。加字段就要加这里（漏加是响亮的 400）。 */
const DECISION_KEYS = ['key', 'verdict', 'note', 'leftKey', 'path', 'keptPath', 'loserPath'] as const

/** `POST /api/netdisk/reconcile/open` 认识的字段。 */
const OPEN_KEYS = ['streamId', 'sourceDirs', 'label'] as const

// —— 以下每份名单 = 对应 handler **实际读的那几个键**（docs/API.md §2）。加字段就要加进来：
// 漏加是响亮的 400，不是静默失效——后者曾让一次「改成功了」其实什么都没发生。

/** `POST /api/netdisk/mappings` 认识的字段（左侧二选一：streamId | tmdb）。 */
const MAPPING_CREATE_KEYS = ['streamId', 'title', 'dirPath', 'autoSync', 'tmdb'] as const
/** `POST /api/netdisk/mappings/:id/rebind` 认识的字段。 */
const REBIND_KEYS = ['dirPath'] as const
/** `PATCH /api/netdisk/mappings/:id/entries/:leftKey` 认识的字段（service.setEntry 的 patch 形状）。 */
const ENTRY_PATCH_KEYS = ['rightFile', 'status'] as const
/** `POST /api/netdisk/mappings/:id/spec/{preview,apply}` 认识的字段。 */
const SPEC_KEYS = ['spec'] as const
/** `POST /api/netdisk/fs/mkdir` 认识的字段。 */
const FS_MKDIR_KEYS = ['path'] as const
/** `POST /api/netdisk/fs/move` 认识的字段。 */
const FS_MOVE_KEYS = ['srcDir', 'dstDir', 'names'] as const
/** `POST /api/netdisk/fs/remove` 认识的字段。 */
const FS_REMOVE_KEYS = ['dir', 'names'] as const
/** `POST /api/netdisk/fs/rename` 认识的字段。 */
const FS_RENAME_KEYS = ['path', 'name'] as const
/** `POST /api/netdisk/fs/put` 认识的 multipart 字段。 */
const FS_PUT_KEYS = ['path', 'file'] as const
/** `POST /api/netdisk/share/create` 认识的字段。 */
const SHARE_CREATE_KEYS = ['path', 'passcode', 'expireDays'] as const
/** `POST /api/netdisk/share/delete` 认识的字段。 */
const SHARE_DELETE_KEYS = ['shareIds'] as const
/** `PUT /api/netdisk/mounts` 认识的字段（期望态整份覆盖）。 */
const MOUNTS_PUT_KEYS = ['mounts'] as const
/** `PUT /api/netdisk/reconcile/config` 认识的字段（= `ReconcileConfigFile` 的全部顶层键）。 */
const RECONCILE_CONFIG_KEYS = ['shows'] as const
/** `POST /api/netdisk/reconcile/undo` 认识的字段。 */
const UNDO_KEYS = ['id'] as const
/** `POST /api/netdisk/reconcile/undo-run` 认识的字段。 */
const UNDO_RUN_KEYS = ['runId'] as const
/** `PATCH /api/netdisk/mappings/:id/follow` 认识的字段。 */
const FOLLOW_PATCH_KEYS = ['enabled'] as const
/** `POST /api/netdisk/follow` 认识的字段。 */
const FOLLOW_CREATE_KEYS = ['tmdb'] as const
/** `POST /api/netdisk/reconcile/bindings/:id/adjudicate` 认识的字段。 */
const ADJUDICATE_KEYS = ['losers', 'force'] as const
/** `POST /api/netdisk/reconcile/bindings/:id/adjudicate/revoke` 认识的字段。 */
const ADJUDICATE_REVOKE_KEYS = ['runId'] as const

/**
 * 严格输入闸的共用一行：body 是对象就查一遍键名，认不出的当场 400 并指出该写哪个。
 * 返回 `null` = 放行（body 不是对象时交给各 handler 自己的形状校验说话）。
 */
function strictBody(
  c: import('hono').Context, body: unknown, allowed: readonly string[],
): Response | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const bad = unknownKey(Object.keys(body as Record<string, unknown>), allowed)
  return bad ? c.json(err('validation_error', unknownKeyMessage('字段', bad, allowed)), 400) : null
}

/** 绑定管理面：列表/详情/建绑/重绑/同步/删除 + entry 修正 + AList 目录浏览（绑定选目录用）。 */
export function registerNetdiskRoutes(app: Hono, deps: NetdiskDeps): void {
  app.get('/api/netdisk/mappings', (c) => c.json(deps.store.list()))
  app.get('/api/netdisk/mappings/:id', (c) => {
    const set = deps.store.get(c.req.param('id'))
    return set ? c.json(set) : c.json(err('not_found', 'mapping not found'), 404)
  })
  /**
   * 建绑定。收两种左侧：
   *   订阅流   `{ streamId, title?, dirPath }`（保留旧形状——存量调用方零改动）
   *   TMDb 作品 `{ tmdb: { id, media, title }, dirPath }`
   * 两者互斥；都不给或都给都是 400 —— 左侧是「清单从哪来」，含糊不得。
   */
  app.post('/api/netdisk/mappings', async (c) => {
    const b = (await c.req.json().catch(() => null)) as {
      streamId?: string; title?: string; dirPath?: string; autoSync?: boolean
      tmdb?: { id?: string; media?: string; title?: string }
    } | null
    const gate = strictBody(c, b, MAPPING_CREATE_KEYS)
    if (gate) return gate
    if (!b?.dirPath) return c.json(err('validation_error', 'dirPath required'), 400)
    if (!!b.streamId === !!b.tmdb) return c.json(err('validation_error', 'exactly one of streamId | tmdb required'), 400)

    let left: MappingLeft
    if (b.streamId) {
      left = { kind: 'stream', streamId: b.streamId, title: b.title ?? b.streamId }
    } else {
      const t = b.tmdb!
      // media 不能猜：TMDb 的 id 按媒体类型分命名空间，猜错就是绑到另一部作品上。
      if (!t.id || (t.media !== 'movie' && t.media !== 'tv')) {
        return c.json(err('validation_error', "tmdb requires { id, media: 'movie'|'tv' }"), 400)
      }
      left = { kind: 'tmdb', id: t.id, media: t.media, title: t.title ?? t.id }
    }
    return c.json(await deps.service.bind({ left, dirPath: b.dirPath, autoSync: b.autoSync }))
  })
  app.post('/api/netdisk/mappings/:id/sync', async (c) => {
    const set = deps.store.get(c.req.param('id'))
    if (!set) return c.json(err('not_found', 'mapping not found'), 404)
    return c.json(await deps.service.sync(set))
  })
  app.post('/api/netdisk/mappings/:id/rebind', async (c) => {
    const b = (await c.req.json().catch(() => null)) as { dirPath?: string } | null
    const gate = strictBody(c, b, REBIND_KEYS)
    if (gate) return gate
    if (!b?.dirPath) return c.json(err('validation_error', 'dirPath required'), 400)
    try {
      return c.json(await deps.service.rebind(c.req.param('id'), b.dirPath))
    } catch (e) {
      return c.json(err('not_found', String((e as Error).message)), 404)
    }
  })
  // ── 影视追更（spec 2026-09-03-work-follow-loop §6）──────────────────────
  // 四条都先问 `deps.follow` 在不在：没装配就 503，绝不静默成功——「开了追更但什么都不会发生」
  // 和「开成功了」长得一模一样，而这条链路无人值守，没人会去核。
  app.get('/api/netdisk/mappings/:id/follow', (c) => {
    if (!deps.follow) return c.json(err('unavailable', 'follow not configured'), 503)
    try {
      return c.json(deps.follow.view(c.req.param('id')))
    } catch (e) {
      return c.json(err('not_found', String((e as Error).message)), 404)
    }
  })
  app.patch('/api/netdisk/mappings/:id/follow', async (c) => {
    if (!deps.follow) return c.json(err('unavailable', 'follow not configured'), 503)
    const b = (await c.req.json().catch(() => null)) as { enabled?: unknown } | null
    const gate = strictBody(c, b, FOLLOW_PATCH_KEYS)
    if (gate) return gate
    // 只收布尔：'false' 这种字符串按真值算就是"关不掉的开关"，而调用方看到的是 200。
    if (typeof b?.enabled !== 'boolean') return c.json(err('validation_error', 'enabled: boolean required'), 400)
    // 绑定不存在是 404（与 GET / run 同一口径）；存在但不是剧集才是 400。
    if (!deps.store.get(c.req.param('id'))) return c.json(err('not_found', 'mapping not found'), 404)
    try {
      return c.json(deps.follow.setEnabled(c.req.param('id'), b.enabled))
    } catch (e) {
      return c.json(err('validation_error', String((e as Error).message)), 400)
    }
  })
  app.post('/api/netdisk/mappings/:id/follow/run', async (c) => {
    if (!deps.follow) return c.json(err('unavailable', 'follow not configured'), 503)
    try {
      return c.json(await deps.follow.runOnce(c.req.param('id'), 'manual'))
    } catch (e) {
      return c.json(err('not_found', String((e as Error).message)), 404)
    }
  })
  /**
   * 「追这部剧」——还没有绑定就连作品目录一起建出来。
   *
   * 目录由后端拼，不收客户端传的路径：落点必须与转存那条路一致（`<quark 挂载点>/From Stream/
   * <不透明作品目录>`），否则追更转存进去的文件不在绑定的右侧，表现成「转存成功但一集都没补上」。
   */
  app.post('/api/netdisk/follow', async (c) => {
    if (!deps.follow) return c.json(err('unavailable', 'follow not configured'), 503)
    const b = (await c.req.json().catch(() => null)) as { tmdb?: { id?: string; media?: string; title?: string; year?: number } } | null
    const gate = strictBody(c, b, FOLLOW_CREATE_KEYS)
    if (gate) return gate
    const t = b?.tmdb
    // 只追剧集：电影没有"下一集"，追更对它无意义（`setEnabled` 那一侧也这么判）。
    if (!t?.id || t.media !== 'tv' || !t.title) return c.json(err('validation_error', "tmdb requires { id, media:'tv', title }"), 400)
    // 与转存那一路（`planBinding`）、与待认领分享账本记的落点是**同一个拼法**——三处各拼一遍
    // 就是三个脑，谁漂一个斜杠都不报错，只是那条分享永远没人认领 / 那些文件永远不在右侧。
    const dirPath = landingDirFor('quark', `${NETDISK_SAVE_DEST}/${opaqueWorkDirName({ id: t.id, media: 'tv' })}`)
    if (!dirPath) return c.json(err('unavailable', 'quark mount preset missing'), 503)
    try {
      return c.json(await deps.follow.ensureBinding(
        { id: t.id, media: 'tv', title: t.title, ...(typeof t.year === 'number' ? { year: t.year } : {}) },
        dirPath,
      ))
    } catch (e) {
      // mkdir / bind 失败（AList 不可达、目录建不出来）：带信封的 502，别让 Hono 的裸 500 把原话吞掉。
      return c.json(err('upstream', String((e as Error).message)), 502)
    }
  })

  /**
   * 删绑定。`?files=1` 连网盘上那个目录一起删（夸克进回收站，约 10 天可捞）。
   *
   * 两件事只能一起做，不能分开给：目录没了而绑定还在，就是 `broken` 那个状态——UI 专门画了个红字
   * 警告它，没道理再造一个出来。反过来也不给：删了绑定再删目录，路径就只剩用户自己记得。
   *
   * **路径由后端从绑定记录里取，不收客户端传的路径**——删除是不可逆的，让调用方指定删哪儿等于
   * 把「删错目录」变成一个参数错误就能触发的事故。
   *
   * 删文件失败 → 502 且**绑定原样保留**：文件还在盘上，把唯一指向它们的记录删掉是二次伤害。
   */
  app.delete('/api/netdisk/mappings/:id', async (c) => {
    const id = c.req.param('id')
    const withFiles = c.req.query('files') === '1'
    if (!withFiles) {
      deps.store.remove(id)
      return c.json({ ok: true })
    }
    const set = deps.store.get(id)
    if (!set) return c.json(err('not_found', 'mapping not found'), 404)
    const dirPath = set.right.path
    const cut = dirPath.replace(/\/+$/, '').lastIndexOf('/')
    const parent = cut > 0 ? dirPath.slice(0, cut) : '/'
    const name = dirPath.replace(/\/+$/, '').slice(cut + 1)
    // 挂载根（/quark）和根目录本身没有「上一层」可删——真删下去是把整个网盘挂载点端掉。
    if (!name || parent === '/') {
      return c.json(err('validation_error', `refusing to delete mount root "${dirPath}"`), 400)
    }
    try {
      await deps.alist.remove(parent, [name])
    } catch (e) {
      return c.json(err('upstream_error', String((e as Error).message)), 502)
    }
    deps.store.remove(id)
    return c.json({ ok: true, filesDeleted: true, dirPath })
  })
  // entry 修正：换绑 {rightFile}、确认 {status:'confirmed'}、拒绝 {status:'rejected'}
  app.patch('/api/netdisk/mappings/:id/entries/:leftKey', async (c) => {
    const b = (await c.req.json().catch(() => null)) as { rightFile?: string | null; status?: string } | null
    if (!b) return c.json(err('validation_error', 'body required'), 400)
    const gate = strictBody(c, b, ENTRY_PATCH_KEYS)
    if (gate) return gate
    try {
      return c.json(deps.service.setEntry(c.req.param('id'), decodeURIComponent(c.req.param('leftKey')), b as never))
    } catch (e) {
      return c.json(err('not_found', String((e as Error).message)), 404)
    }
  })
  // 释放临时人工订正，随后可通过 sync/spec apply 回到自动规则匹配。
  app.post('/api/netdisk/mappings/:id/entries/:leftKey/reset', (c) => {
    try {
      return c.json(deps.service.clearCorrection(c.req.param('id'), decodeURIComponent(c.req.param('leftKey'))))
    } catch (e) {
      return c.json(err('not_found', String((e as Error).message)), 404)
    }
  })
  // ---- 规则编辑（三原语的 HTTP surface；MCP surface 见 mcp/server.ts 的 netdisk_* 工具）----
  // 校验失败(invalid matchSpec)→ 400；绑定不存在 → 404；AList 上游失败 → 502。
  const specErr = (c: import('hono').Context, e: unknown) => {
    const msg = String((e as Error).message)
    if (/^invalid matchSpec/.test(msg)) return c.json(err('validation_error', msg), 400)
    if (/绑定不存在/.test(msg)) return c.json(err('not_found', msg), 404)
    return c.json(err('upstream_error', msg), 502)
  }
  // 预览候选（写谱的是对话里的模型，它读 netdisk_residue 自己产一份）：dry-run 出
  // before/after/changed/correctedConflicts。
  app.post('/api/netdisk/mappings/:id/spec/preview', async (c) => {
    const b = (await c.req.json().catch(() => null)) as { spec?: unknown } | null
    const gate = strictBody(c, b, SPEC_KEYS)
    if (gate) return gate
    if (!b || b.spec === undefined) return c.json(err('validation_error', 'spec required'), 400)
    try {
      return c.json(await deps.service.previewSpec(c.req.param('id'), b.spec))
    } catch (e) { return specErr(c, e) }
  })
  // 落规则：校验 + 写 binding.matchSpec + 重同步（corrected 钉住）。返回更新后的绑定。
  app.post('/api/netdisk/mappings/:id/spec/apply', async (c) => {
    const b = (await c.req.json().catch(() => null)) as { spec?: unknown } | null
    const gate = strictBody(c, b, SPEC_KEYS)
    if (gate) return gate
    if (!b || b.spec === undefined) return c.json(err('validation_error', 'spec required'), 400)
    try {
      return c.json(await deps.service.applySpec(c.req.param('id'), b.spec))
    } catch (e) { return specErr(c, e) }
  })

  // AList 文件操作（建目录 / 批量移动）——网盘整理用。都是对 deps.alist 的薄透传，
  // 凭据留在后端已认证的 client 里（带 401 自动重登），调用方不碰 token。
  app.post('/api/netdisk/fs/mkdir', async (c) => {
    const b = (await c.req.json().catch(() => null)) as { path?: string } | null
    const gate = strictBody(c, b, FS_MKDIR_KEYS)
    if (gate) return gate
    if (!b?.path) return c.json(err('validation_error', 'path required'), 400)
    try {
      await deps.alist.mkdir(b.path)
      return c.json({ ok: true })
    } catch (e) {
      return c.json(err('upstream_error', String((e as Error).message)), 502)
    }
  })
  app.post('/api/netdisk/fs/move', async (c) => {
    const b = (await c.req.json().catch(() => null)) as { srcDir?: string; dstDir?: string; names?: string[] } | null
    const gate = strictBody(c, b, FS_MOVE_KEYS)
    if (gate) return gate
    if (!b?.srcDir || !b?.dstDir || !Array.isArray(b?.names)) {
      return c.json(err('validation_error', 'srcDir, dstDir, names[] required'), 400)
    }
    try {
      await deps.alist.move(b.srcDir, b.dstDir, b.names)
      return c.json({ ok: true, moved: b.names.length })
    } catch (e) {
      return c.json(err('upstream_error', String((e as Error).message)), 502)
    }
  })
  // 删除。补齐 mkdir/move 之外的第三只手——库里剔重（如某条「下架集」经交叉验证发现源站其实
  // 有原版，只是网盘那份编号错位 + 用了规避字）走这里。夸克侧进回收站，约 10 天内可捞回。
  app.post('/api/netdisk/fs/remove', async (c) => {
    const b = (await c.req.json().catch(() => null)) as { dir?: string; names?: string[] } | null
    const gate = strictBody(c, b, FS_REMOVE_KEYS)
    if (gate) return gate
    if (!b?.dir || !Array.isArray(b?.names) || b.names.length === 0) {
      return c.json(err('validation_error', 'dir, names[] required'), 400)
    }
    try {
      await deps.alist.remove(b.dir, b.names)
      return c.json({ ok: true, removed: b.names.length })
    } catch (e) {
      return c.json(err('upstream_error', String((e as Error).message)), 502)
    }
  })
  app.post('/api/netdisk/fs/rename', async (c) => {
    const b = (await c.req.json().catch(() => null)) as { path?: string; name?: string } | null
    const gate = strictBody(c, b, FS_RENAME_KEYS)
    if (gate) return gate
    if (!b?.path || !b?.name) return c.json(err('validation_error', 'path and name required'), 400)
    try {
      await deps.alist.rename(b.path, b.name)
      return c.json({ ok: true })
    } catch (e) {
      return c.json(err('upstream_error', String((e as Error).message)), 502)
    }
  })

  /**
   * 上传（multipart：`path` + `file`）。下游是导出脚本每周把数据包传进 `/quark/闲鱼数据包/<pack>/`，
   * 它只调这一条、不碰登录态。文件**边收边落到临时文件**（不整份进内存），再按已知大小流式 PUT 给
   * OpenList——OpenList 从 `Content-Length` 读文件大小，multipart 段在读完之前不知道自己多长，所以
   * 要先落盘一次。父目录先 `mkdir` 一次（OpenList 递归建、已存在即成功），同名覆盖是 OpenList 语义。
   * 字段顺序不是契约的一部分：`file` 先到也照收。
   */
  app.post('/api/netdisk/fs/put', async (c) => {
    const boundary = multipartBoundary(c.req.header('content-type'))
    if (!boundary || !c.req.raw.body) return c.json(err('validation_error', 'multipart/form-data with path and file required'), 400)
    const tmp = join(tmpdir(), `stream-put-${randomBytes(8).toString('hex')}`)
    let path: string | undefined
    let size: number | undefined
    try {
      try {
        for await (const part of parseMultipart(c.req.raw.body, boundary)) {
          const bad = unknownKey([part.name], FS_PUT_KEYS)
          if (bad) return c.json(err('validation_error', unknownKeyMessage('字段', bad, FS_PUT_KEYS)), 400)
          if (part.name === 'path') {
            const chunks: Uint8Array[] = []
            for await (const ch of part.data) chunks.push(ch)
            path = Buffer.concat(chunks).toString('utf8')
          } else {
            let n = 0
            await pipeline(
              Readable.from(part.data),
              new Transform({ transform(ch: Buffer, _e, cb) { n += ch.length; cb(null, ch) } }),
              createWriteStream(tmp),
            )
            size = n
          }
        }
      } catch (e) {
        return c.json(err('validation_error', `multipart 解析失败：${(e as Error).message}`), 400)
      }
      if (!path || size === undefined) return c.json(err('validation_error', 'path and file required'), 400)
      if (!path.startsWith('/') || path.endsWith('/')) return c.json(err('validation_error', 'path must be an absolute file path (not a directory)'), 400)
      const fileSize = size
      try {
        const parent = path.slice(0, path.lastIndexOf('/')) || '/'
        await deps.alist.mkdir(parent)
        await deps.alist.put(path, () => Readable.toWeb(createReadStream(tmp)) as ReadableStream<Uint8Array>, fileSize)
        return c.json({ ok: true, size: fileSize })
      } catch (e) {
        // errText 展开 cause 链：undici 只报一句 "fetch failed"，真因（超时 / 连接被拒）在 cause 里
        return c.json(err('upstream_error', errText(e)), 502)
      }
    } finally {
      await unlink(tmp).catch(() => undefined)
    }
  })

  /**
   * 网盘内目录 → 分享链接。挂在这里而不是 app.ts 的 `share/{verify,save}` 旁边：那两条只要有网盘登录态
   * 就能用（分享是别人的），这条要先从 OpenList 挂载表认出路径属于哪个网盘（目录是自己的），
   * 与 fs/* 同一道 AList 门。`passcode` 缺省 = 公开分享；`expireDays` 0 = 永久（默认）。
   */
  app.post('/api/netdisk/share/create', async (c) => {
    if (!deps.shareCreate) return c.json(err('unavailable', 'netdisk share create not configured'), 503)
    const b = (await c.req.json().catch(() => null)) as { path?: unknown; passcode?: unknown; expireDays?: unknown } | null
    const gate = strictBody(c, b, SHARE_CREATE_KEYS)
    if (gate) return gate
    if (!b || typeof b.path !== 'string' || !b.path) return c.json(err('validation_error', 'path required'), 400)
    if (b.passcode !== undefined && !(typeof b.passcode === 'string' && /^[A-Za-z0-9]{4}$/.test(b.passcode))) {
      return c.json(err('validation_error', 'passcode must be 4 letters/digits'), 400)
    }
    if (b.expireDays !== undefined && !(typeof b.expireDays === 'number' && Number.isInteger(b.expireDays) && b.expireDays >= 0)) {
      return c.json(err('validation_error', 'expireDays must be a non-negative integer (0 = permanent)'), 400)
    }
    try {
      return c.json(await deps.shareCreate({ path: b.path, passcode: b.passcode, expireDays: b.expireDays }))
    } catch (e) {
      if (e instanceof ShareCreateError) return c.json(err(e.code, e.message), SHARE_ERROR_STATUS[e.code])
      return c.json(err('upstream_error', String((e as Error).message)), 502)
    }
  })

  /**
   * 当前账号建出去的分享，一页。只读，也是删除的取数腿：手里只有一条链接（`/s/<pwdId>`）时，
   * 在这里按 `pwdId` 对上行、拿它的 `shareId` 去删——删除端点只认 `shareId`。
   *
   * 分页是真的（夸克 `_total` 一并回）：`page * size < total` 就还有下一页。**别只读第一页当全部**。
   */
  app.get('/api/netdisk/share/list', async (c) => {
    if (!deps.shareList) return c.json(err('unavailable', 'netdisk share list not configured'), 503)
    const num = (raw: string | undefined, name: string): number | undefined | Response => {
      if (raw === undefined || raw === '') return undefined
      // Number('') === 0、Number('1x') === NaN：两个都得挡，不然一个笔误会被当成"第 0 页"静默生效。
      const n = Number(raw)
      return Number.isInteger(n) ? n : c.json(err('validation_error', `${name} must be an integer`), 400)
    }
    const page = num(c.req.query('page'), 'page')
    if (page instanceof Response) return page
    const size = num(c.req.query('size'), 'size')
    if (size instanceof Response) return size
    try {
      return c.json(await deps.shareList({ page, size }))
    } catch (e) {
      if (e instanceof ShareCreateError) return c.json(err(e.code, e.message), SHARE_ERROR_STATUS[e.code])
      return c.json(err('upstream_error', String((e as Error).message)), 502)
    }
  })

  /**
   * 按 `shareId` 批量删分享。**删链接，不删文件**，且不可逆、夸克没有分享回收站
   * （语义与实测证据见 `shared/netdisk/quark/share-api.ts` 的 `quarkShareDelete`）。
   *
   * 逐条发、逐条回判：`200 { results:[{shareId, ok, message?}], deleted, failed }`。一条失败其余照删，
   * 所以 `failed > 0` 时仍是 200——判据在 body 里，不在状态码上。整批做不成的事（参数、没登录态）才非 200。
   */
  app.post('/api/netdisk/share/delete', async (c) => {
    if (!deps.shareDelete) return c.json(err('unavailable', 'netdisk share delete not configured'), 503)
    const b = (await c.req.json().catch(() => null)) as { shareIds?: unknown } | null
    const gate = strictBody(c, b, SHARE_DELETE_KEYS)
    if (gate) return gate
    if (!b || !Array.isArray(b.shareIds) || !b.shareIds.length || b.shareIds.some((id) => typeof id !== 'string' || !id.trim())) {
      return c.json(err('validation_error', 'shareIds must be a non-empty array of non-empty strings'), 400)
    }
    try {
      return c.json(await deps.shareDelete({ shareIds: b.shareIds as string[] }))
    } catch (e) {
      if (e instanceof ShareCreateError) return c.json(err(e.code, e.message), SHARE_ERROR_STATUS[e.code])
      return c.json(err('upstream_error', String((e as Error).message)), 502)
    }
  })

  // AList 目录列举，两种用途：
  //  - 默认（单层，含子目录）：绑定向导逐级浏览选目录（透传原始 list）。
  //  - recursive=1（递归，仅文件，name 为相对子路径）：文件选择框的候选——与同步真正配对用的
  //    那套嵌套文件一致（rightFile 就是这种相对子路径，如 `更新/837.xxx.mp3`）。
  //  - recursive=1&dirs=1（递归，文件 + 目录行）：目录选择框跨子树搜索用。**默认关**：
  //    文件选择框的平铺列表以「没有可下钻的目录」为前提（见 alist-client listDirRecursive）。
  app.get('/api/netdisk/fs', async (c) => {
    const path = c.req.query('path') ?? '/'
    const recursive = c.req.query('recursive') === '1' || c.req.query('recursive') === 'true'
    // refresh=1 → 强制 AList 回源（绕过其目录缓存）。文件选择器用它，让人工订正对着网盘现状选真名。
    const refresh = c.req.query('refresh') === '1' || c.req.query('refresh') === 'true'
    const includeDirs = c.req.query('dirs') === '1' || c.req.query('dirs') === 'true'
    try {
      const files = recursive
        ? await deps.alist.listDirRecursive(path, 5, refresh, includeDirs)
        : await deps.alist.listEntries(path, refresh)
      return c.json({ path, files })
    } catch (e) {
      return c.json(err('upstream_error', String((e as Error).message)), 502)
    }
  })

  /**
   * 路径 → 同源直链（302）。整理面板的试听按钮把它当 `<audio src>`：一条删除建议对不对，
   * 最后只有耳朵能裁——活体 2026-08-02 那份 `玄关笔记/37.申与酉.mp3` 里装的其实是
   * 《037.三谈身边灵异事》，编号是当初搬文件时按名字错配上去的，任何元数据都看不出来。
   *
   * **为什么不复用现成的取链口**：`/api/media/videos/resolve` 与 `netdisk-subtitle-list`
   * 那几条都按**集**寻址（`id`/`key` → `netdisk.lookup(leftKey)`），而整理面板里最需要试听的
   * 恰恰是**没被任何集认领**的那批文件——按集反查恒空。`/api/media/netdisk-play` 虽然吃 path，
   * 但它是**视频转码代理**：先 `fileId` 再问网盘要转码流，对一个 mp3 是两趟白跑的上游请求，
   * 且没装转码 Provider 时直接 400。这里要的只是"把这份文件的字节放出来"，就一条 302。
   *
   * 取链失败**不许静默**给个坏 URL：播放器只会显示"放不出来"，而真因（文件已删 / AList 断）
   * 就丢了。502 带上原文，前端据此弹一句人话。
   */
  app.get('/api/netdisk/raw', async (c) => {
    const path = c.req.query('path')
    if (!path) return c.json(err('validation_error', 'path required'), 400)
    try {
      return c.redirect(await deps.service.rawGatewayUrl(path), 302)
    } catch (e) {
      return c.json(err('upstream_error', String((e as Error).message)), 502)
    }
  })

  // ---- 挂载网盘（期望态在 settings，AList 只是执行器）----
  const mountsReady = () => deps.settings && deps.fetchCookies

  /**
   * preset 目录 + 每个 preset 的实时健康（UI 首屏一次拿全）。
   * 现做两次取数：AList storage 列表 + 登录态快照 —— 任一失败降级不 500：
   *   storage 拉不到 → alistReachable:false，状态按「无 storage」推；cookie 拉不到 → 视作无 cookie。
   */
  app.get('/api/netdisk/mounts', async (c) => {
    if (!mountsReady()) return c.json(err('not_configured', 'mounts need settings + cookie wiring'), 501)
    let storages: AlistStorage[] = []
    let alistReachable = true
    try { storages = await deps.alist.listStorages() } catch { alistReachable = false }
    let cookieData: Record<string, BrowserCookie[]> = {}
    try { cookieData = await deps.fetchCookies!() } catch { /* 视作无 cookie */ }
    const byPath = new Map(storages.map((s) => [s.mount_path, s]))
    const presets = MOUNT_PRESETS.map((p) => {
      const hasCookie = !!cookiesForDomain(cookieData, p.cookieDomain)
      return {
        id: p.id, label: p.label, driver: p.driver, cookieDomain: p.cookieDomain, mountPath: p.mountPath,
        hasCookie, status: mountStatusOf(byPath.get(p.mountPath), hasCookie),
      }
    })
    // searchableSourceTypes：影视页「找资源」的前端过滤用它当允许集。AList 拉不到
    // storage → 退到 magnet/ed2k（它们不依赖 AList，一定可用），前端按 alistReachable
    // 标降级。不过滤会把一堆转存不了的链接糊上来，等于功能白做。
    return c.json({ presets, mounts: deps.settings!.get().alist?.mounts ?? [], alistReachable, searchableSourceTypes: searchableSourceTypes(storages) })
  })

  /** 覆盖期望态并立即 reconcile；返回执行结果（missingCookie → UI 引导登录）。 */
  app.put('/api/netdisk/mounts', async (c) => {
    if (!mountsReady()) return c.json(err('not_configured', 'mounts need settings + cookie wiring'), 501)
    const body = await c.req.json<{ mounts?: AlistMountEntry[] }>().catch(() => null)
    const gate = strictBody(c, body, MOUNTS_PUT_KEYS)
    if (gate) return gate
    if (!body || !Array.isArray(body.mounts)) return c.json(err('bad_request', 'expected { mounts: [] }'), 400)
    const unknown = body.mounts.filter((m) => !findPreset(m.presetId))
    if (unknown.length) return c.json(err('bad_request', `unknown preset: ${unknown[0].presetId}`), 400)
    deps.settings!.setAlistMounts(body.mounts)
    try {
      return c.json(await reconcileMounts(body.mounts, deps.alist, deps.fetchCookies!))
    } catch (e) {
      return c.json(err('upstream_error', String((e as Error).message)), 502)
    }
  })

  /**
   * 自动挂载：期望态 = 全部 curated preset —— 有 cookie 的建/自愈，没 cookie 的落 missingCookie 桶。
   * 用户不管期望态；cookie 刚同步完点「刷新」或首屏自动跑一次即可挂上。
   */
  app.post('/api/netdisk/mounts/reconcile', async (c) => {
    if (!mountsReady()) return c.json(err('not_configured', 'mounts need settings + cookie wiring'), 501)
    const desired = MOUNT_PRESETS.map((p) => ({ presetId: p.id }))
    deps.settings!.setAlistMounts(desired)
    try {
      return c.json(await reconcileMounts(desired, deps.alist, deps.fetchCookies!))
    } catch (e) {
      return c.json(err('upstream_error', String((e as Error).message)), 502)
    }
  })

  // ---- 归档器（spec §4）：来源目录 → 权威(listLeft) 对账 → 三分流（move/delete-dup/pending）。
  // 观察档默认：autoExecute:false 的 show 只 preview、不落写；execute 端点显式调用才真的动网盘。
  const reconcileReady = () => !!deps.reconcile
  app.get('/api/netdisk/reconcile/config', (c) => {
    if (!reconcileReady()) return c.json(err('not_configured', 'reconcile not wired'), 503)
    // 读模型：配置 + 现解的货架地址（付费=绑定落地目录，下架=下架 stream 扫的目录，见 P8）。
    // 地址不在配置里存，界面却必须看得见"东西会搬去哪"。
    return c.json(deps.reconcile!.getConfigView())
  })
  /**
   * 就地开一次整理（spec 2026-08-25 §4.2）。一次请求把四步做完，失败回滚到进来之前。
   *
   * 严格输入闸：这是 agent 高频打的写入面，字段拼错必须响亮（`docs/API.md` §2）——
   * 静默忽略一个字段在这条路上意味着"整理开成了，只是没按你说的目录开"。
   */
  app.post('/api/netdisk/reconcile/open', async (c) => {
    if (!deps.openReconcile) return c.json(err('not_configured', 'reconcile open not wired'), 503)
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!b || typeof b !== 'object') return c.json(err('validation_error', 'body required'), 400)
    const badField = unknownKey(Object.keys(b), OPEN_KEYS)
    if (badField) return c.json(err('validation_error', unknownKeyMessage('字段', badField, OPEN_KEYS)), 400)
    if (typeof b.streamId !== 'string' || !b.streamId) return c.json(err('validation_error', 'streamId required'), 400)
    if (!Array.isArray(b.sourceDirs) || !b.sourceDirs.every((d) => typeof d === 'string')) {
      return c.json(err('validation_error', 'sourceDirs must be string[]'), 400)
    }
    try {
      return c.json(await deps.openReconcile({
        streamId: b.streamId,
        sourceDirs: b.sourceDirs as string[],
        ...(typeof b.label === 'string' ? { label: b.label } : {}),
      }))
    } catch (e) {
      // 用户改得动的（订阅不存在、目录派生不出、配置校验不过）是 400；网盘/上游炸了才是 502。
      if (e instanceof OpenReconcileError || e instanceof ValidationError) {
        return c.json(err('validation_error', e.message), 400)
      }
      return c.json(err('upstream_error', String((e as Error).message)), 502)
    }
  })
  app.put('/api/netdisk/reconcile/config', async (c) => {
    if (!reconcileReady()) return c.json(err('not_configured', 'reconcile not wired'), 503)
    const b = await c.req.json().catch(() => null)
    const gate = strictBody(c, b, RECONCILE_CONFIG_KEYS)
    if (gate) return gate
    if (!b || !Array.isArray((b as { shows?: unknown }).shows)) return c.json(err('validation_error', 'shows[] required'), 400)
    try {
      deps.reconcile!.putConfig(b as never)
    } catch (e) {
      if (e instanceof ValidationError) return c.json(err('validation_error', e.message), 400)
      throw e
    }
    return c.json({ ok: true })
  })
  // 权威清单（节目单）本身——**查权威的唯一一扇门**：探针、排错、将来的 hover card 都从这里读。
  // 别拿 `/api/items` 顶替：那条路上挂着播放投影（付费集在网盘没配上 → 整条音频换成封面图，
  // 时长与 track_id 全没），它回答的是"前端此刻看到什么"，不是"库里存了什么"。
  // 只读：不扫网盘、不规划、不落账，与 preview 走同一条取数路径（见 ReconcileService.authority）。
  app.get('/api/netdisk/reconcile/:show/authority', async (c) => {
    if (!reconcileReady()) return c.json(err('not_configured', 'reconcile not wired'), 503)
    try {
      return c.json(await deps.reconcile!.authority(c.req.param('show')))
    } catch (e) {
      return c.json(err('not_found', String((e as Error).message)), 404)
    }
  })
  app.get('/api/netdisk/reconcile/bindings/:bindingId/authority', async (c) => {
    if (!reconcileReady()) return c.json(err('not_configured', 'reconcile not wired'), 503)
    try {
      return c.json(await deps.reconcile!.authorityForBinding(c.req.param('bindingId')))
    } catch (e) {
      return c.json(err('not_found', String((e as Error).message)), 404)
    }
  })
  // 按订阅取权威——**不要求这条流配过整理，也不要求它有绑定**。网盘入口靠它回答"你该用哪个"
  // （`stats.needsSupply` > 0 → 整理；= 0 → 挂载）。上面两扇门都要先有配置，答不了这一问。
  app.get('/api/netdisk/reconcile/streams/:streamId/authority', async (c) => {
    if (!reconcileReady()) return c.json(err('not_configured', 'reconcile not wired'), 503)
    return c.json(await deps.reconcile!.authorityForStream(c.req.param('streamId')))
  })
  app.post('/api/netdisk/reconcile/:show/preview', async (c) => {
    if (!reconcileReady()) return c.json(err('not_configured', 'reconcile not wired'), 503)
    try {
      return c.json(await deps.reconcile!.preview(c.req.param('show')))
    } catch (e) {
      return c.json(err('not_found', String((e as Error).message)), 404)
    }
  })
  app.post('/api/netdisk/reconcile/:show/execute', async (c) => {
    if (!reconcileReady()) return c.json(err('not_configured', 'reconcile not wired'), 503)
    try {
      return c.json(await deps.reconcile!.execute(c.req.param('show')))
    } catch (e) {
      return c.json(err('not_found', String((e as Error).message)), 404)
    }
  })
  // 任意一条绑定的原地整理（影视「一键去重」）：不需要在整理面板里配过 show——服务端合成一份
  // 退化配置（无暂存区、无第二货架）走同一条 preview/execute（spec §2）。删除类动作必过预览确认，
  // 所以这里仍是"两步"：先 preview 出将删清单，人点了确认才 execute。
  app.post('/api/netdisk/reconcile/bindings/:bindingId/preview', async (c) => {
    if (!reconcileReady()) return c.json(err('not_configured', 'reconcile not wired'), 503)
    try {
      return c.json(await deps.reconcile!.previewBinding(c.req.param('bindingId')))
    } catch (e) {
      // 配置层面的问题（货架地址撞了来源目录之类）是 400——用户改得动；绑定不存在才是 404。
      if (e instanceof ValidationError) return c.json(err('validation_error', e.message), 400)
      return c.json(err('not_found', String((e as Error).message)), 404)
    }
  })
  /**
   * 归档动完文件之后**必须重新同步一次那条绑定**：整理会把文件搬进 `S<nn>/`、给名字加上编号前缀，
   * 而绑定里存的是相对路径——不重同步，节目单那一侧还指着旧路径，点播放 404，**没有一处会喊**。
   * 只对 tmdb tv 那支做：别的绑定的整理不改节目单指着的路径。
   *
   * 同步失败不影响这次请求的回执——文件已经动完了，回执讲的是那件事；同步下一轮还会自己补上。
   */
  const resyncBinding = async (bindingId: string | undefined): Promise<void> => {
    if (!bindingId || !deps.service) return
    const set = deps.store.get(bindingId)
    if (!set || set.left.kind !== 'tmdb' || set.left.media !== 'tv') return
    try {
      await deps.service.sync(set)
    } catch (e) {
      console.warn(`[netdisk] 归档后重新同步 ${bindingId} 失败（文件已经动完了）：${(e as Error).message}`)
    }
  }
  app.post('/api/netdisk/reconcile/bindings/:bindingId/execute', async (c) => {
    if (!reconcileReady()) return c.json(err('not_configured', 'reconcile not wired'), 503)
    let res: Awaited<ReturnType<ReconcileService['executeBinding']>>
    try {
      res = await deps.reconcile!.executeBinding(c.req.param('bindingId'))
    } catch (e) {
      if (e instanceof ValidationError) return c.json(err('validation_error', e.message), 400)
      return c.json(err('not_found', String((e as Error).message)), 404)
    }
    // **在 try 之外**：归档本身已经成功，同步的死活不许把这次回执改写成 404（同 undo-run 路由）。
    await resyncBinding(c.req.param('bindingId'))
    return c.json(res)
  })
  app.post('/api/netdisk/reconcile/undo', async (c) => {
    if (!reconcileReady()) return c.json(err('not_configured', 'reconcile not wired'), 503)
    const b = (await c.req.json().catch(() => null)) as { id?: string } | null
    const gate = strictBody(c, b, UNDO_KEYS)
    if (gate) return gate
    if (!b?.id) return c.json(err('validation_error', 'id required'), 400)
    try {
      await deps.reconcile!.undo(b.id)
      return c.json({ ok: true })
    } catch (e) {
      return c.json(err('not_found', String((e as Error).message)), 404)
    }
  })
  /**
   * 整轮撤销：把 `runId` 那一轮写下的溯源行倒序走回去（搬回 / 改回 / 重建目录）。
   *
   * 与上面那条单条 `undo` 是两件事，别合并：单条撤的是"这一份文件搬错了"，这一条撤的是
   * "这一轮整个归档不该发生"——归档一轮会同时改名、搬运、删空目录，逐条撤既要人自己排倒序，
   * 也撤不干净（`rmdir` 单独重建一个空目录不还原任何东西）。删撤不回，只进 `skipped`。
   */
  app.post('/api/netdisk/reconcile/undo-run', async (c) => {
    if (!reconcileReady()) return c.json(err('not_configured', 'reconcile not wired'), 503)
    const b = (await c.req.json().catch(() => null)) as { runId?: string } | null
    const gate = strictBody(c, b, UNDO_RUN_KEYS)
    if (gate) return gate
    if (!b?.runId) return c.json(err('validation_error', 'runId required'), 400)
    let res: Awaited<ReturnType<ReconcileService['undoRun']>>
    try {
      res = await deps.reconcile!.undoRun(b.runId)
    } catch (e) {
      return c.json(err('not_found', String((e as Error).message)), 404)
    }
    // 撤销同样把路径改回去了——同一条理由，方向相反（绑定从账本反查，见 `bindingOfRun`）。
    // **在 try 之外**：撤销本身已经成功，同步的死活不许把这次回执改写成 404。
    await resyncBinding(deps.reconcile!.bindingOfRun(b.runId))
    return c.json(res)
  })
  /**
   * 轮末裁决器手动入口（spec 2026-09-03-netdisk-llm-adjudicator §3 触发点 2）——「现在就裁」。
   * 只裁归档待定卡，不带追更候选（那一路只有追更轮自己知道本轮判成了哪些 pending）。
   * `losers` 默认 false（手动入口没有追更轮那种"无人值守必须过健康闸"的前提，交给调用方拍板）。
   */
  app.post('/api/netdisk/reconcile/bindings/:bindingId/adjudicate', async (c) => {
    if (!deps.adjudicate) return c.json(err('not_configured', 'adjudicate not wired'), 503)
    const b = (await c.req.json().catch(() => null)) as { losers?: unknown; force?: unknown } | null
    const gate = strictBody(c, b, ADJUDICATE_KEYS)
    if (gate) return gate
    if (b?.losers !== undefined && typeof b.losers !== 'boolean') {
      return c.json(err('validation_error', 'losers must be boolean'), 400)
    }
    if (b?.force !== undefined && typeof b.force !== 'boolean') {
      return c.json(err('validation_error', 'force must be boolean'), 400)
    }
    let res: Awaited<ReturnType<AdjudicationService['run']>>
    try {
      res = await deps.adjudicate.run(c.req.param('bindingId'), { trigger: 'manual', losers: b?.losers ?? false, ...(b?.force ? { force: true } : {}) })
    } catch (e) {
      return c.json(err('not_found', String((e as Error).message)), 404)
    }
    // **在 try 之外**：裁决本身已经成功，同步的死活不许把这次回执改写成 404（同 execute/undo-run）。
    if (res.applied > 0) await resyncBinding(c.req.param('bindingId'))
    return c.json(res)
  })
  /**
   * 整批撤回一轮模型裁的决定（按 `note` 前缀 `llm:<runId>`）——「模型裁的」随时能一把抹掉，
   * 不牵动人工那些决定。撤销只删决定行，不碰追更候选已经转存到货架上的文件（见
   * `AdjudicationService.revoke` 头注）。
   */
  app.post('/api/netdisk/reconcile/bindings/:bindingId/adjudicate/revoke', async (c) => {
    if (!deps.adjudicate) return c.json(err('not_configured', 'adjudicate not wired'), 503)
    const b = (await c.req.json().catch(() => null)) as { runId?: string } | null
    const gate = strictBody(c, b, ADJUDICATE_REVOKE_KEYS)
    if (gate) return gate
    if (!b?.runId) return c.json(err('validation_error', 'runId required'), 400)
    const revoked = await deps.adjudicate.revoke(b.runId)
    return c.json({ ok: true, revoked })
  })
  app.get('/api/netdisk/reconcile/provenance', (c) => {
    if (!reconcileReady()) return c.json(err('not_configured', 'reconcile not wired'), 503)
    return c.json(deps.reconcile!.listProvenance())
  })
  /**
   * 「AI 建议 vs 人最终选择」的对照账本 —— **放开自动采纳的门槛就读这一个数**。
   *
   * **只有 GET**——写入不走这条路。AI 那半截现在有两个生产写入方：对话裁决（模型拿
   * `netdisk_transcribe` 听、自己判、用 `reconcile_decide` 落账）与轮末裁决器（`reconcile_adjudicate`
   * / 追更轮末自动触发，见 `docs/MATCHING.md` 「轮末裁决」一节），两者都经各自的服务内部写
   * `SuggestionLog.record`，不经这个端点。人那半截（决定端点写决定时回填）照旧。**别再开一个写
   * 入口**：绕开这两个既有写入方另起一条，账本必然对不齐，而对不齐的账本比没有账本更坏——它
   * 看起来像个数。
   *
   * `summary` **永远统计全表**，不跟着 `state`/`agreement`/`limit` 变：一个跟着当前页变的
   * 一致率，读的人会当成总体。四格（agreed/disagreed/inconclusive/open）互斥且穷尽，相加
   * 恰好是 `countable`——少一格就会有一类结局静默消失。
   *
   * 看反例（AI 判错的实证，比一致率数字有用得多）：`?agreement=disagree`。
   */
  app.get('/api/netdisk/reconcile/suggestions', (c) => {
    if (!reconcileReady()) return c.json(err('not_configured', 'reconcile not wired'), 503)
    const q = c.req.query()
    const STATES = ['open', 'answered'] as const
    const AGREEMENTS = ['agree', 'disagree', 'inconclusive'] as const
    const state = STATES.find((s) => s === q.state)
    const agreement = AGREEMENTS.find((a) => a === q.agreement)
    if (q.state && !state) return c.json(err('validation_error', "state must be 'open'|'answered'"), 400)
    if (q.agreement && !agreement) {
      return c.json(err('validation_error', "agreement must be 'agree'|'disagree'|'inconclusive'"), 400)
    }
    // 坏的 limit/cursor 退回缺省即可（读端点，没有副作用）；库层自己夹在 [1, MAX_LIMIT]。
    const num = (s?: string) => { const n = Number(s); return s && Number.isFinite(n) ? n : undefined }
    return c.json(deps.reconcile!.listSuggestions({
      ...(state ? { state } : {}),
      ...(agreement ? { agreement } : {}),
      ...(num(q.limit) != null ? { limit: num(q.limit)! } : {}),
      ...(num(q.cursor) != null ? { cursor: num(q.cursor)! } : {}),
    }))
  })
  app.post('/api/netdisk/reconcile/decisions', async (c) => {
    if (!reconcileReady()) return c.json(err('not_configured', 'reconcile not wired'), 503)
    const raw = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    // 写错字段名不再静默变成"撤回"——活体撞过：传 `decision`（正确是 `verdict`）拿到 {ok:true}，
    // 实际走的是 verdict==null 的撤回分支。这是 agent 高频打的写入面，按 docs/API.md §2 接闸。
    if (raw && typeof raw === 'object') {
      const bad = unknownKey(Object.keys(raw), DECISION_KEYS)
      if (bad) return c.json(err('validation_error', unknownKeyMessage('字段', bad, DECISION_KEYS)), 400)
    }
    const b = raw as
      {
        key?: string; verdict?: 'exempt' | 'tombstone' | 'not-episode' | 'is-episode' | 'prefer' | null
        note?: string; leftKey?: string; path?: string; keptPath?: string; loserPath?: string
      } | null
    // 「留哪一份」是**两个文件路径**的组合（不带 leftKey：第二货架的契约就是"文件自己是一集"，
    // 那里根本没有集身份）。`verdict: null` + 两侧 = 撤回，下一轮重新问。
    if (b?.keptPath != null || b?.loserPath != null) {
      if (!b.keptPath || !b.loserPath) return c.json(err('validation_error', 'keptPath and loserPath are required together'), 400)
      if (b.keptPath === b.loserPath) return c.json(err('validation_error', 'keptPath and loserPath must differ'), 400)
      if (b.verdict !== 'prefer' && b.verdict != null) {
        return c.json(err('validation_error', "verdict must be 'prefer'|null when keptPath/loserPath are given"), 400)
      }
      deps.reconcile!.setPreferred(b.keptPath, b.loserPath, b.verdict === 'prefer')
      return c.json({ ok: true })
    }
    // 问句的两个答案都是**一个文件 + 一集**的组合，不是一条身份键：两侧原样收，组合键由后端拼
    // （前端不许自造 key）。`verdict: null` + 两侧 = 撤回，下一轮重新问。
    if (b?.leftKey != null || b?.path != null) {
      if (!b.leftKey || !b.path) return c.json(err('validation_error', 'leftKey and path are required together'), 400)
      if (b.verdict !== 'not-episode' && b.verdict !== 'is-episode' && b.verdict != null) {
        return c.json(err('validation_error', "verdict must be 'not-episode'|'is-episode'|null when leftKey/path are given"), 400)
      }
      // 撤回（null）要落到人**当初答的那一半**上：一律走 setIsEpisode(false) 会顺手把同一对的
      // 「不是这一集」也删掉，等于替他撤了另一条他没提的决定。
      if (b.verdict === 'is-episode') deps.reconcile!.setIsEpisode(b.leftKey, b.path)
      else if (b.verdict === 'not-episode') deps.reconcile!.setNotEpisode(b.leftKey, b.path)
      else {
        deps.reconcile!.setNotEpisode(b.leftKey, b.path, false)
        deps.reconcile!.setIsEpisode(b.leftKey, b.path, false)
      }
      return c.json({ ok: true })
    }
    if (!b?.key) return c.json(err('validation_error', 'key required'), 400)
    if (b.verdict !== 'exempt' && b.verdict !== 'tombstone' && b.verdict != null) {
      return c.json(err('validation_error', "verdict must be 'exempt'|'tombstone'|null"), 400)
    }
    deps.reconcile!.setDecision(b.key, b.verdict ?? null, b.note)
    return c.json({ ok: true })
  })
}
