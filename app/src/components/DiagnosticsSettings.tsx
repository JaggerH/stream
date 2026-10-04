import { useCallback, useEffect, useState } from 'react'
import { useDiagnosticsEnabled } from '../lib/diagnostics/flag.ts'
import { downloadBundle } from '../lib/diagnostics/exportBundle.ts'
import { openRepo } from '../lib/diagnostics/repository.ts'
import { hasIndexedDB } from '../lib/diagnostics/capabilities.ts'
import { Button } from './ui/button.tsx'
import { Switch } from './ui/switch.tsx'
import { SettingsBlock, SettingsRow } from './settings/SettingsSection.tsx'
import type { DiagnosticSession } from '../lib/diagnostics/types.ts'

/**
 * 诊断飞行记录器的控制面。开关默认关闭；开启后 App 才会建 recorder。
 * 这里只做「开关 / 提示 / 导出 / 清除」—— 原始时间线不常驻渲染到页面上（spec）。
 *
 * 渲染成 SettingsRow/SettingsBlock 而不是自带排版：它和 Debug 面板、卡顿归因同住
 * BackendSettings 的「调试」一节，自己另起一套行距和控件（原先是原生 checkbox）会在
 * 三者并排时露馅。
 */
export function DiagnosticsSettings() {
  const [enabled, setEnabled] = useDiagnosticsEnabled()
  const [sessions, setSessions] = useState<DiagnosticSession[]>([])
  const supported = hasIndexedDB()

  const refresh = useCallback(async () => {
    if (!supported) return
    try {
      const repo = await openRepo()
      setSessions(await repo.listSessions())
      repo.close()
    } catch {
      setSessions([])
    }
  }, [supported])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const abnormal = sessions.filter((s) => s.status === 'suspected-abnormal')
  const current = sessions.find((s) => s.status === 'running')

  const exportSession = async (id: string) => {
    const repo = await openRepo()
    const bundle = await repo.exportSession(id)
    repo.close()
    if (bundle) downloadBundle(bundle, document)
  }

  const clearAll = async () => {
    const repo = await openRepo()
    await repo.clear()
    repo.close()
    await refresh()
  }

  if (!supported) {
    return (
      <SettingsBlock>
        <p className="text-[12px] text-muted-foreground">此浏览器不支持 IndexedDB，诊断记录不可用。</p>
      </SettingsBlock>
    )
  }

  return (
    <>
      <SettingsRow
        label="诊断记录"
        description="记录 heap / DOM / 音频缓冲趋势，用于排查标签页 OOM。数据只存本地，不上传。"
        control={<Switch checked={enabled} onCheckedChange={setEnabled} aria-label="诊断记录" />}
      />

      {abnormal.length > 0 ? (
        <SettingsBlock>
          <div className="space-y-2 rounded-md border border-[var(--acr-border-soft)] p-2.5">
            <p className="text-[12px] text-muted-foreground">
              上次会话疑似异常终止（{new Date(abnormal[0].startedAt).toLocaleString()} 起，{abnormal[0].ua}）。
              这是「没能正常收尾」的推断，不等于确证 OOM。
            </p>
            <Button size="sm" variant="ghost" type="button" onClick={() => void exportSession(abnormal[0].id)}>
              导出上次异常终止记录
            </Button>
          </div>
        </SettingsBlock>
      ) : null}

      <SettingsBlock>
        <div className="flex flex-wrap gap-2">
          {current ? (
            <Button size="sm" variant="ghost" type="button" onClick={() => void exportSession(current.id)}>
              导出当前会话
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" type="button" onClick={() => void clearAll()}>
            清除诊断数据
          </Button>
        </div>
      </SettingsBlock>
    </>
  )
}
