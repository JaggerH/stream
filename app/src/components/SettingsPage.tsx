import { useEffect, useState } from 'react'
import { RemoteAccessSettings } from './RemoteAccessSettings.tsx'
import { HarvestBrowserSettings } from './HarvestBrowserSettings.tsx'
import { SettingsBlock, SettingsGroup, SettingsRow, SettingsSection } from './settings/SettingsSection.tsx'
import type { Connection } from '../lib/api.ts'

interface ArchiveInfo {
  root: string
  exists: boolean
  writable: boolean
  tracks: number
}

/**
 * 「管理 → 设置」：不归任何频道、也不归设备的那几项全局设置。它们原先住在 `BackendSettings`
 * 那张弹窗里，而那张弹窗从首次发布起就没有入口，这几项在面板里一直找不到。
 *
 * 没搬过来的：Backend URL（这份 bundle 的后端地址由宿主给，填了也不生效）、Debug 面板开关和
 * 诊断记录（`DebugBox` 没人渲染、也没人按开关建 recorder——挂出来就是点了没反应的键）。
 */
export function SettingsPage({ conn }: { conn: Connection }) {
  const [archive, setArchive] = useState<ArchiveInfo | null>(null)
  useEffect(() => {
    fetch(`${conn.baseUrl}/api/settings/archive`)
      .then((r) => (r.ok ? (r.json() as Promise<ArchiveInfo>) : null))
      .then(setArchive)
      .catch(() => {})
  }, [conn])

  return (
    <SettingsGroup>
      {/* 采集浏览器：Stream 不自带浏览器，采集骑用户自己那个 Chrome。两侧都装了
          （WSL + Windows）时必须由用户选——见组件注释里那条"选错不报错"的说明。 */}
      <SettingsSection title="采集浏览器" footnote="扩展要装在被选中的那一侧">
        <SettingsBlock>
          <HarvestBrowserSettings conn={conn} />
        </SettingsBlock>
      </SettingsSection>

      {/* 令牌只在本机看得到（后端对非 loopback 的这一口直接 403），所以别的设备
          没法靠"打开一下设置页"把自己放进来。 */}
      <SettingsSection title="远程访问" footnote="本机访问不需要令牌">
        <SettingsBlock>
          <RemoteAccessSettings conn={conn} />
        </SettingsBlock>
      </SettingsSection>

      <SettingsSection title="音频归档" footnote="在 config.yaml 的 audio_archive_root 修改（改后需重启）">
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
  )
}
