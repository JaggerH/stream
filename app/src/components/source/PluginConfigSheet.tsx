import { useEffect, useState } from 'react'
import { Loader2Icon } from 'lucide-react'
import { api } from '../../lib/api.ts'
import type { Connection } from '../../lib/api.ts'
import type { PackageRole, PluginSummary } from '../../lib/types.ts'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '../acrylic/sheet.tsx'
import { Button } from '../acrylic/button.tsx'
import {
  SettingsBlock,
  SettingsGroup,
  SettingsNote,
  SettingsRow,
  SettingsSection,
} from '../settings/SettingsSection.tsx'
import { NetdiskMounts } from '../netdisk/NetdiskMounts.tsx'
import { NetdiskBindings } from '../netdisk/NetdiskBindings.tsx'

/** 面板要的那几格：名字、说明来源，以及后端标的 `role`（`/api/packages` 出线）。 */
export type PluginConfigTarget = Partial<PluginSummary> & { id: string; name: string; role?: PackageRole }

/** Per-plugin config panel. **按 `role` 分支，不按包 id**（`docs/PACKAGE.md`「宿主与包的边界」：
 *  前端不按站分支）。`role: 'netdisk-base'`（宿主的网盘底座）是内置托管的：一块只读实例状态
 *  （凭证由 Stream 接管，用户没什么要填）+ 网盘挂载 + 网盘绑定。其余包给一段只读的「配置从哪来」说明。
 *
 *  右侧 Sheet 而非居中 Dialog：配置面板（后端设置、Source 配置）一律从右边来；网盘底座这一支塞着
 *  挂载 + 绑定两大块，窄宽度本来就挤。
 *
 *  There used to be a 内置实例 / 接入已有实例 radio on top. It was removed because it did nothing:
 *  the choice was stored and fed back into a derived local/cloud badge, but a plugin's real
 *  request URL comes from config/env in each adapter, and the panel never offered a field to
 *  type an external instance's address into. */
export function PluginConfigSheet({
  open,
  onOpenChange,
  conn,
  plugin,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  conn: Connection
  plugin: PluginConfigTarget | null
}) {
  const netdiskBase = plugin?.role === 'netdisk-base'
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* 网盘底座这一支塞着「挂载 + 绑定」两大块，绑定汇总视图本身就是 264px 侧栏 + 一张逐集
          对照表，30rem 里读不成。它单独给宽，其余插件只有一段只读说明，维持窄。
          `sm:max-w-*` 必须显式写：SheetContent 的 side=right 默认带 `sm:max-w-sm`(24rem)，
          它和 `w-*` 不同组，光加宽 w 会被这条断点上限压回去。 */}
      <SheetContent
        side="right"
        className={
          netdiskBase
            ? 'w-[56rem] max-w-[92vw] sm:max-w-[92vw] p-0'
            : 'w-[30rem] max-w-[92vw] sm:max-w-[92vw] p-0'
        }
      >
        <div className="flex min-h-0 flex-1 flex-col">
          <SheetHeader className="px-4 pt-4">
            <SheetTitle>{plugin?.name ?? '插件'} · 配置</SheetTitle>
            <SheetDescription className="text-[11px]">
              {netdiskBase ? '内置网盘底座（Stream 托管，网盘直链后备源）。' : '该插件的配置来源说明。'}
            </SheetDescription>
          </SheetHeader>

          <div className="scrollbar-mac min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-1">
            <SettingsGroup>
              {netdiskBase ? (
                <>
                  <NetdiskBaseInfo conn={conn} />
                  {/* 网盘挂载：期望态开关面板（T14）。挂载是网盘底座的配置，归属于此而非全局后端设置。
                      面板关闭时整棵不渲染，天然懒加载。数据自 /api/netdisk/mounts。 */}
                  <SettingsSection title="网盘挂载">
                    <SettingsBlock>
                      <NetdiskMounts apiBase={conn.baseUrl} />
                    </SettingsBlock>
                  </SettingsSection>
                  {/* 绑定：挂载之后的另一半。挂载说「这个网盘接进来了」，绑定说「这个目录是哪部剧/哪个
                      歌单的」——两者都是网盘底座的配置，却只有挂载在这里露过面，绑定得靠用户在
                      别处翻到。同一个面板同一个地方，才找得到。 */}
                  <SettingsSection title="网盘绑定">
                    <SettingsBlock>
                      <NetdiskBindings apiBase={conn.baseUrl} />
                    </SettingsBlock>
                  </SettingsSection>
                </>
              ) : (
                <ReadOnlyConfigInfo plugin={plugin} />
              )}
            </SettingsGroup>
          </div>

          <SheetFooter className="flex-row justify-end border-t border-[var(--acr-border-soft)] px-4 py-3">
            <Button size="small" type="button" onClick={() => onOpenChange(false)}>
              完成
            </Button>
          </SheetFooter>
        </div>
      </SheetContent>
    </Sheet>
  )
}

/** 内置网盘底座实例只读状态。凭证由 Stream 自动接管（provision：admin 密码生成 + JWT 换发），
 *  用户没有任何要填的 —— 只展示实例地址和一条活探测（POST /api/settings/alist/test 空体 = 探存储态；
 *  这组端点属于宿主的网盘底座领域，见 `docs/PACKAGE.md` 边界一节的豁免栏）。 */
function NetdiskBaseInfo({ conn }: { conn: Connection }) {
  const [url, setUrl] = useState('')
  const [probe, setProbe] = useState<'loading' | 'ok' | 'err'>('loading')
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    setProbe('loading')
    api.alist.get(conn)
      .then((s) => { if (alive) setUrl(s.url) })
      .catch(() => {})
    api.alist.test(conn, {})
      .then((r) => { if (!alive) return; setProbe(r.ok ? 'ok' : 'err'); setErr(r.error || '') })
      .catch((e) => { if (!alive) return; setProbe('err'); setErr((e as Error).message) })
    return () => { alive = false }
  }, [conn.baseUrl])

  return (
    <SettingsSection title="内置实例" footnote="凭证由 Stream 自动托管，无需配置。">
      <SettingsRow
        label="状态"
        control={
          probe === 'loading' ? (
            <Loader2Icon className="size-3.5 animate-spin text-muted-foreground" aria-label="探测中" />
          ) : probe === 'ok' ? (
            <span className="text-[11px] text-emerald-500">运行中</span>
          ) : (
            <span className="text-[11px] text-destructive" title={err}>不可用</span>
          )
        }
      />
      {url ? (
        <SettingsRow
          label="地址"
          control={<span className="block max-w-[16rem] truncate font-mono text-[11px] text-muted-foreground">{url}</span>}
        />
      ) : null}
      {probe === 'err' && err ? <SettingsNote className="text-destructive">{err}</SettingsNote> : null}
    </SettingsSection>
  )
}

/** Read-only explainer for plugins whose config isn't editable here yet. */
function ReadOnlyConfigInfo({ plugin }: { plugin: PluginConfigTarget | null }) {
  const launchNote: Record<string, string> = {
    container: '容器后端（由 docker compose 管理）。启停容器请用 pnpm plugins compose + docker compose up/stop。',
    external: '连接外部服务，无需本机容器。',
    builtin: '进程内能力，随后端一起运行，无独立配置。',
    manual: '手动配置。',
  }
  return (
    <SettingsSection title="配置来源">
      <SettingsNote>此插件暂无可在此编辑的配置项。</SettingsNote>
      {plugin?.launch?.mode ? <SettingsNote>{launchNote[plugin.launch.mode] ?? ''}</SettingsNote> : null}
      {plugin?.description ? <SettingsNote className="text-foreground/80">{plugin.description}</SettingsNote> : null}
      {plugin?.repository ? (
        <SettingsNote>
          <a href={plugin.repository} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
            查看项目文档
          </a>
        </SettingsNote>
      ) : null}
    </SettingsSection>
  )
}
