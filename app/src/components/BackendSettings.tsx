import { useEffect, useMemo, useState } from 'react'
import { useBackend } from '../lib/backend.tsx'
import { useDebugEnabled } from '../lib/debugFlag.ts'
import { Switch } from './ui/switch.tsx'
import { RemoteAccessSettings } from './RemoteAccessSettings.tsx'
import { HarvestBrowserSettings } from './HarvestBrowserSettings.tsx'
import { DiagnosticsSettings } from './DiagnosticsSettings.tsx'
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from './acrylic/sheet.tsx'
import { Button } from './acrylic/button.tsx'
import { Input } from './acrylic/input.tsx'
import {
  SettingsBlock,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  useAccordion,
} from './settings/SettingsSection.tsx'
import type { Connection } from '../lib/api.ts'

const KEY = 'stream.backend_url'

interface ArchiveInfo {
  root: string
  exists: boolean
  writable: boolean
  tracks: number
}

/**
 * Backend URL setting (backend-endpoint-discovery D5). Persists an override into
 * localStorage `stream.backend_url` (empty = clear = use discovery defaults) and
 * re-runs the discovery ladder on save via useBackend().reconnect(). Also hosts the
 * consolidated 「调试」 section (Debug 面板 toggle → the floating DebugBox; 诊断记录 → the
 * frontend IndexedDB flight recorder; plus what is and isn't switchable about event-loop-lag
 * attribution), and read-only audio-archive status.
 * Source capability configuration lives in Source Config Sheet.
 *
 * 排版走 settings/SettingsSection 的分组内嵌列表——和 SourceConfigSheet / PluginConfigSheet 同一套。
 * 提交语义分成两层：Backend URL 要重连，所以它自己带一个「保存」；其余开关即时生效，底部只留
 * 「完成」。（早先是「关闭 / 保存」并排放在底部，读起来像不点保存开关就不生效。）
 */
export function BackendSettings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { reconnect, upstream, status } = useBackend()
  const [value, setValue] = useState(() => window.localStorage.getItem(KEY) ?? '')
  const [debug, setDebug] = useDebugEnabled()
  const [archive, setArchive] = useState<ArchiveInfo | null>(null)
  // 「调试」默认展开：见下方该节的注释（Debug 面板原是顶层裸开关，不能因为收纳而变难够到）。
  const section = useAccordion('debug')
  const conn = useMemo<Connection>(() => ({ baseUrl: upstream }), [upstream])
  useEffect(() => {
    if (!open) return
    fetch(`${upstream}/api/settings/archive`)
      .then((r) => (r.ok ? (r.json() as Promise<ArchiveInfo>) : null))
      .then(setArchive)
      .catch(() => {})
  }, [open, upstream])
  const save = () => {
    const v = value.trim()
    if (v) window.localStorage.setItem(KEY, v)
    else window.localStorage.removeItem(KEY)
    reconnect() // 立刻回发现阶梯，用新配置重探
    onClose()
  }
  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <SheetContent side="right" className="w-[26rem] p-0" onOpenAutoFocus={(e) => e.preventDefault()}>
        <div className="flex min-h-0 flex-1 flex-col">
          <SheetHeader className="px-4 pt-4">
            <SheetTitle>后端设置</SheetTitle>
          </SheetHeader>

          <div className="scrollbar-mac min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-1">
            <SettingsGroup>
              <SettingsSection
                title="连接"
                footnote={`当前：${status === 'connected' ? upstream || '同源' : status}`}
              >
                <SettingsRow layout="stacked" label="Backend URL" htmlFor="backend-url-input">
                  <div className="flex items-center gap-2">
                    <Input
                      id="backend-url-input"
                      size="large"
                      className="min-w-0 flex-1"
                      value={value}
                      onChange={(e) => setValue(e.target.value)}
                      placeholder="留空 = 自动发现"
                    />
                    {/* 只有这一项需要显式提交——改地址要重跑发现阶梯并重连。 */}
                    <Button size="small" variant="secondary" type="button" onClick={save}>
                      保存
                    </Button>
                  </div>
                </SettingsRow>
              </SettingsSection>

              {/* 调试三件事住一起：Debug 面板（浮层，展示后端 debug bus 的所有频道，含 loop 卡顿）、
                  诊断记录（前端自己的 IndexedDB 飞行记录器，另一套机制）、以及卡顿归因的说明。
                  默认展开——Debug 面板开关原先是顶层裸开关，是三者里最常用的一个，收进折叠节后
                  若再默认收起就比原来多一次点击。 */}
              <SettingsSection title="调试" collapsible {...section('debug')}>
                <SettingsRow
                  label="Debug 面板"
                  description="播放 / 下载 / 视频解析 / 事件循环卡顿——浮层实时显示，含失败原因"
                  control={<Switch checked={debug} onCheckedChange={(checked) => setDebug(checked)} />}
                />
                <DiagnosticsSettings />
                <SettingsBlock>
                  <div className="space-y-1.5 text-[11px] leading-relaxed text-muted-foreground">
                    <p className="text-[12px] font-medium text-foreground">事件循环卡顿</p>
                    <p>
                      <span className="text-foreground/80">探测</span>
                      ——常开、关不掉。同步操作堵住事件循环超过 250ms 就落一条 <code>loop</code> 频道记录（期间所有请求、定时器、健康探测都被卡住）。
                    </p>
                    <p>
                      <span className="text-foreground/80">任务级归因</span>
                      ——常开。每条卡顿记录附上窗口内在跑的任务（采集 / 请求 / 下载 / cookie 刷新），并区分「整段在窗口内」和「跨窗口」。
                    </p>
                    <p>
                      <span className="text-foreground/80">函数级归因</span>
                      ——默认关，且<span className="text-foreground/80">没有开关</span>。要精确到函数名须设 <code>STREAM_LOOP_PROFILE=1</code> 后重启后端：武装 V8 profiler 本身就要付 250–500ms 卡顿，不适合随手开。
                    </p>
                  </div>
                </SettingsBlock>
              </SettingsSection>

              {/* 采集浏览器：Stream 不自带浏览器，采集骑用户自己那个 Chrome。两侧都装了
                  （WSL + Windows）时必须由用户选——见组件注释里那条"选错不报错"的说明。 */}
              <SettingsSection
                title="采集浏览器"
                collapsible
                {...section('harvestBrowser')}
                footnote="扩展要装在被选中的那一侧"
              >
                <SettingsBlock>
                  <HarvestBrowserSettings conn={conn} />
                </SettingsBlock>
              </SettingsSection>

              {/* 令牌只在本机看得到（后端对非 loopback 的这一口直接 403），所以别的设备
                  没法靠"打开一下设置页"把自己放进来。 */}
              <SettingsSection
                title="远程访问"
                collapsible
                {...section('remoteAccess')}
                footnote="本机访问不需要令牌"
              >
                <SettingsBlock>
                  <RemoteAccessSettings conn={conn} />
                </SettingsBlock>
              </SettingsSection>

              <SettingsSection
                title="音频归档"
                collapsible
                {...section('archive')}
                footnote="在 config.yaml 的 audio_archive_root 修改（改后需重启）"
              >
                <SettingsRow
                  label="落盘路径"
                  control={
                    <span className="block max-w-[13rem] truncate font-mono text-[11px] text-muted-foreground">
                      {archive ? archive.root : '载入中…'}
                    </span>
                  }
                />
                <SettingsRow
                  label="状态"
                  control={
                    <span className="text-[11px] text-muted-foreground">
                      {archive
                        ? `${archive.exists ? (archive.writable ? '可写' : '只读') : '路径不存在'} · ${archive.tracks} 首入库`
                        : '—'}
                    </span>
                  }
                />
              </SettingsSection>

            </SettingsGroup>
          </div>

          <SheetFooter className="flex-row justify-end border-t border-[var(--acr-border-soft)] px-4 py-3">
            <Button size="small" type="button" onClick={onClose}>
              完成
            </Button>
          </SheetFooter>
        </div>
      </SheetContent>
    </Sheet>
  )
}
